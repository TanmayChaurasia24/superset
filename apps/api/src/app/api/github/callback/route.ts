import { db } from "@superset/db/client";
import { githubInstallations } from "@superset/db/schema";
import { Client } from "@upstash/qstash";
import { and, eq, ne } from "drizzle-orm";

import { env } from "@/env";
import {
	exitOAuthFlow,
	readStateCookie,
	STATE_COOKIES,
} from "@/lib/integrations/oauthFlow";
import { resolveCallback } from "@/lib/integrations/resolveCallback";
import { verifySignedState } from "@/lib/oauth-state";
import { githubApp } from "../octokit";

const qstash = new Client({ token: env.QSTASH_TOKEN });

function getSettingsUrl(
	organizationId?: string,
	query?: Record<string, string>,
) {
	const url = new URL(`${env.NEXT_PUBLIC_WEB_URL}/integrations/github`);
	if (organizationId) url.searchParams.set("organizationId", organizationId);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

/**
 * Callback handler for GitHub App installation.
 * GitHub redirects here after the user installs/configures the app.
 */
export async function GET(request: Request) {
	let requestedOrganizationId: string | undefined;
	const bound = readStateCookie(request, STATE_COOKIES.github);
	if (bound) {
		const stateData = verifySignedState(bound);
		if (stateData) requestedOrganizationId = stateData.organizationId;
	}

	if (new URL(request.url).searchParams.get("setup_action") === "cancel") {
		return exitOAuthFlow(
			STATE_COOKIES.github,
			getSettingsUrl(requestedOrganizationId, {
				error: "installation_cancelled",
			}),
		);
	}

	const callback = await resolveCallback(request, {
		params: ["installation_id"],
		redirect: (error) => getSettingsUrl(requestedOrganizationId, { error }),
		cookie: STATE_COOKIES.github,
	});
	if (callback instanceof Response) return callback;
	const { organizationId, userId, params, exit } = callback;
	const installationId = params.installation_id;

	try {
		const octokit = await githubApp.getInstallationOctokit(
			Number(installationId),
		);

		const installationResult = await octokit
			.request("GET /app/installations/{installation_id}", {
				installation_id: Number(installationId),
			})
			.catch((error: Error) => {
				console.error("[github/callback] Failed to fetch installation:", error);
				return null;
			});

		if (!installationResult) {
			return exit(
				getSettingsUrl(organizationId, { error: "installation_fetch_failed" }),
			);
		}

		const installation = installationResult.data;

		// Extract account info - account can be User or Enterprise
		const account = installation.account;
		const accountLogin =
			account && "login" in account ? account.login : (account?.name ?? "");
		const accountType =
			account && "type" in account ? account.type : "Organization";

		// If another organization already owns this installation_id, refuse to
		// silently take it over — we'd otherwise either crash on the
		// installation_id UNIQUE constraint or sever the other org's integration
		// without notice. Ask the user to disconnect on the existing org (or
		// uninstall in GitHub, which fires our uninstall webhook) first.
		const existingForInstallation =
			await db.query.githubInstallations.findFirst({
				where: and(
					eq(githubInstallations.installationId, String(installation.id)),
					ne(githubInstallations.organizationId, organizationId),
				),
				columns: { id: true },
			});

		if (existingForInstallation) {
			return exit(
				getSettingsUrl(organizationId, { error: "already_connected" }),
			);
		}

		// Save the installation to our database
		const [savedInstallation] = await db
			.insert(githubInstallations)
			.values({
				organizationId,
				connectedByUserId: userId,
				installationId: String(installation.id),
				accountLogin,
				accountType,
				permissions: installation.permissions as Record<string, string>,
			})
			.onConflictDoUpdate({
				target: [githubInstallations.organizationId],
				set: {
					connectedByUserId: userId,
					installationId: String(installation.id),
					accountLogin,
					accountType,
					permissions: installation.permissions as Record<string, string>,
					suspended: false,
					suspendedAt: null, // Clear suspension if reinstalling
					updatedAt: new Date(),
				},
			})
			.returning();

		if (!savedInstallation) {
			return exit(getSettingsUrl(organizationId, { error: "save_failed" }));
		}

		// Queue initial sync job. In development the queue cannot reach
		// localhost, so the job endpoint is called directly, as triggerSync does.
		const syncUrl = `${env.NEXT_PUBLIC_API_URL}/api/github/jobs/initial-sync`;
		const syncBody = {
			installationDbId: savedInstallation.id,
			organizationId,
		};
		try {
			if (env.NODE_ENV === "development") {
				fetch(syncUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(syncBody),
				}).catch((error) => {
					console.error("[github/callback] Dev sync failed:", error);
				});
			} else {
				await qstash.publishJSON({ url: syncUrl, body: syncBody, retries: 3 });
			}
		} catch (error) {
			console.error(
				"[github/callback] Failed to queue initial sync job:",
				error,
			);
			return exit(
				getSettingsUrl(organizationId, { warning: "sync_queue_failed" }),
			);
		}

		return exit(
			getSettingsUrl(organizationId, { success: "github_installed" }),
		);
	} catch (error) {
		console.error("[github/callback] Unexpected error:", error);
		return exit(getSettingsUrl(organizationId, { error: "unexpected" }));
	}
}

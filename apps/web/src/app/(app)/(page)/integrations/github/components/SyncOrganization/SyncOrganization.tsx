"use client";

import { Trans } from "@lingui/react/macro";
import { authClient } from "@superset/auth/client";
import { Button } from "@superset/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface SyncOrganizationProps {
	organizationId: string;
}

export function SyncOrganization({ organizationId }: SyncOrganizationProps) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const queryClient = useQueryClient();
	const hasRun = useRef(false);
	const [error, setError] = useState(false);

	const syncOrg = useCallback(() => {
		setError(false);
		authClient.organization
			.setActive({ organizationId })
			.then((res) => {
				if (res.error) {
					console.error(
						"[SyncOrganization] Failed to switch organization:",
						res.error,
					);
					setError(true);
					return;
				}
				queryClient.invalidateQueries();

				const newParams = new URLSearchParams(searchParams.toString());
				newParams.delete("organizationId");
				const search = newParams.toString();
				const dest = `${pathname}${search ? `?${search}` : ""}`;

				router.replace(dest);
				router.refresh();
			})
			.catch((err) => {
				console.error("[SyncOrganization] Failed to switch organization:", err);
				setError(true);
			});
	}, [organizationId, pathname, queryClient, router, searchParams]);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;
		syncOrg();
	}, [syncOrg]); // eslint-disable-line react-hooks/exhaustive-deps

	if (error) {
		return (
			<div className="flex flex-col items-center justify-center space-y-4 py-16">
				<AlertCircle className="size-8 text-destructive" />
				<p className="text-muted-foreground">
					<Trans>Failed to synchronize organization.</Trans>
				</p>
				<Button variant="outline" onClick={syncOrg}>
					<Trans>Try Again</Trans>
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center justify-center py-16">
			<Loader2 className="size-8 animate-spin text-muted-foreground" />
		</div>
	);
}

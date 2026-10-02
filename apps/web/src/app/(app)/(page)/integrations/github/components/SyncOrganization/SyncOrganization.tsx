"use client";

import { authClient } from "@superset/auth/client";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

interface SyncOrganizationProps {
	organizationId: string;
}

export function SyncOrganization({ organizationId }: SyncOrganizationProps) {
	const router = useRouter();
	const queryClient = useQueryClient();
	const hasRun = useRef(false);

	useEffect(() => {
		if (hasRun.current) return;
		hasRun.current = true;

		authClient.organization
			.setActive({ organizationId })
			.then(() => {
				queryClient.invalidateQueries();
				router.replace("/integrations/github");
				router.refresh();
			})
			.catch((error) => {
				console.error(
					"[SyncOrganization] Failed to switch organization:",
					error,
				);
				// Fallback to removing the query string anyway
				router.replace("/integrations/github");
			});
	}, [organizationId, router, queryClient]);

	return (
		<div className="flex flex-col items-center justify-center py-16">
			<Loader2 className="size-8 animate-spin text-muted-foreground" />
		</div>
	);
}

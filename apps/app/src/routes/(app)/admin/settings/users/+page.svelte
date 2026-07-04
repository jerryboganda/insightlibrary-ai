<script lang="ts">
	import { goto } from '$app/navigation';
	import { Loader2 } from '@lucide/svelte';

	// The dedicated tenant identity / RBAC console lives at /admin/users.
	// This settings tab redirects there to avoid duplication (matches prototype).
	$effect(() => {
		goto('/admin/users', { replaceState: true });
	});
</script>

<div class="flex h-full min-h-[60vh] items-center justify-center p-8">
	<div class="flex items-center gap-3 text-sm text-zinc-500">
		<Loader2 class="h-4 w-4 animate-spin text-indigo-400" />
		Redirecting to Users &amp; Roles...
	</div>
</div>

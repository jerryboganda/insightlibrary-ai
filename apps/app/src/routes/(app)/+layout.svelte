<script lang="ts">
	import Sidebar from '$lib/components/shell/Sidebar.svelte';
	import Topbar from '$lib/components/shell/Topbar.svelte';
	import Copilot from '$lib/components/shell/Copilot.svelte';

	let { children } = $props();
</script>

<div class="flex h-screen overflow-hidden">
	<Sidebar />
	<div class="flex min-w-0 flex-1 flex-col">
		<Topbar />
		<main class="flex-1 overflow-y-auto p-6">
			{@render children()}
		</main>
	</div>
	<Copilot />
</div>

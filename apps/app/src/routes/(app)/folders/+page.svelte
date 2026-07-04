<script lang="ts">
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Library, Plus, FolderOpen } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, PageHeader, Button, Input, Skeleton } from '$lib/components/ui';
	import { healthColor } from '$lib/utils';

	const qc = useQueryClient();
	const folders = createQuery({ queryKey: ['folders'], queryFn: () => api.listFolders() });

	let creating = $state(false);
	let name = $state('');

	const create = createMutation({
		mutationFn: (n: string) => api.createFolder(n),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['folders'] });
			name = '';
			creating = false;
		}
	});
</script>

<div class="mx-auto max-w-6xl space-y-6">
	<PageHeader title="Library & Folders" description="Domain folders group documents into a shared single source of truth.">
		{#snippet actions()}
			<Button onclick={() => (creating = !creating)}>
				<Plus class="h-4 w-4" /> New Folder
			</Button>
		{/snippet}
	</PageHeader>

	{#if creating}
		<Card class="flex items-center gap-3 p-4">
			<Input bind:value={name} placeholder="Folder name (e.g. Cardiology Core)" onkeydown={(e) => e.key === 'Enter' && name.trim() && $create.mutate(name)} />
			<Button onclick={() => name.trim() && $create.mutate(name)} disabled={$create.isPending}>Create</Button>
			<Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
		</Card>
	{/if}

	<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
		{#if $folders.isLoading}
			{#each Array(3) as _, i (i)}<Card class="p-5"><Skeleton class="h-24" /></Card>{/each}
		{:else}
			{#each $folders.data ?? [] as folder (folder.id)}
				<a href="/folders/{folder.id}" class="group block">
					<Card hover class="p-5">
						<div class="flex items-center gap-3">
							<div class="rounded-lg bg-indigo-500/10 p-2 text-indigo-400"><FolderOpen class="h-5 w-5" /></div>
							<h3 class="font-medium text-zinc-100 group-hover:text-indigo-300">{folder.name}</h3>
						</div>
						<div class="mt-4 grid grid-cols-3 gap-2 text-center">
							<div><div class="font-mono text-lg text-zinc-100">{folder.docs}</div><div class="text-[10px] text-zinc-500">Docs</div></div>
							<div><div class="font-mono text-lg text-zinc-100">{folder.topics}</div><div class="text-[10px] text-zinc-500">Topics</div></div>
							<div><div class="font-mono text-lg {healthColor(folder.health)}">{folder.health}%</div><div class="text-[10px] text-zinc-500">Health</div></div>
						</div>
						<div class="mt-3 text-xs text-zinc-500">Updated {folder.lastUpdated}</div>
					</Card>
				</a>
			{/each}
		{/if}
	</div>
</div>

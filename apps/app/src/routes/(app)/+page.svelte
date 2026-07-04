<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { FileStack, Brain, Network, Flame, Plus } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, PageHeader, Skeleton } from '$lib/components/ui';

	const folders = createQuery({ queryKey: ['folders'], queryFn: () => api.listFolders() });
	const review = createQuery({ queryKey: ['review'], queryFn: () => api.listReview() });

	const totalDocs = $derived($folders.data?.reduce((s, f) => s + f.docs, 0) ?? 0);
	const totalTopics = $derived($folders.data?.reduce((s, f) => s + f.topics, 0) ?? 0);
	const conflicts = $derived($review.data?.filter((r) => r.status === 'pending').length ?? 0);

	const stats = $derived([
		{ label: 'Total Documents', value: String(totalDocs), icon: FileStack, tone: 'bg-indigo-500/10 text-indigo-400' },
		{ label: 'Canonical Topics', value: totalTopics.toLocaleString(), icon: Brain, tone: 'bg-emerald-500/10 text-emerald-400' },
		{ label: 'Graph Nodes (Entities)', value: '42.1k', icon: Network, tone: 'bg-amber-500/10 text-amber-400' },
		{ label: 'Pending Conflicts', value: String(conflicts), icon: Flame, tone: 'bg-rose-500/10 text-rose-400' }
	]);
</script>

<div class="mx-auto max-w-6xl space-y-8">
	<PageHeader
		title="Knowledge Engine Overview"
		description="Manage your domain folders and track document intel processing."
	/>

	<div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
		{#each stats as stat (stat.label)}
			<div class="glass-panel flex items-start gap-4 rounded-xl p-4">
				<div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg {stat.tone}">
					<stat.icon class="h-5 w-5" />
				</div>
				<div>
					<p class="text-xs font-medium text-zinc-500">{stat.label}</p>
					<p class="text-2xl font-bold text-zinc-100">{stat.value}</p>
				</div>
			</div>
		{/each}
	</div>

	<section class="space-y-4">
		<h2 class="text-lg font-semibold tracking-tight text-zinc-200">Domain Folders</h2>
		<div class="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
			{#if $folders.isLoading}
				{#each Array(3) as _, i (i)}
					<Card class="p-5"><Skeleton class="h-28 w-full" /></Card>
				{/each}
			{:else}
				{#each $folders.data ?? [] as folder (folder.id)}
					<a href="/folders/{folder.id}" class="group block">
						<div
							class="glass-panel relative overflow-hidden rounded-xl border border-zinc-800 p-5 transition-all duration-300 group-hover:-translate-y-1 group-hover:border-indigo-500/30"
						>
							<div class="absolute top-0 right-0 -mt-10 -mr-10 h-32 w-32 rounded-full bg-indigo-500/5 blur-2xl"></div>
							<h3 class="font-medium text-zinc-100 transition-colors group-hover:text-indigo-300">{folder.name}</h3>
							<div class="mt-4 flex flex-col gap-2 text-xs">
								<div class="flex justify-between"><span class="text-zinc-500">Documents</span><span class="font-mono text-zinc-300">{folder.docs} uploaded</span></div>
								<div class="flex justify-between"><span class="text-zinc-500">Topics Detected</span><span class="font-mono text-zinc-300">{folder.topics}</span></div>
								<div class="flex justify-between"><span class="text-zinc-500">SSOT Health</span><span class="font-mono text-emerald-400">{folder.health}%</span></div>
							</div>
							<div class="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-zinc-900">
								<div class="h-full rounded-full bg-emerald-500/80" style="width: {folder.health}%"></div>
							</div>
						</div>
					</a>
				{/each}
			{/if}

			<a
				href="/folders"
				class="glass-panel flex min-h-[160px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-800 p-5 text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
			>
				<div class="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900">
					<Plus class="h-5 w-5" />
				</div>
				<span class="text-sm font-medium">New Domain Folder</span>
			</a>
		</div>
	</section>
</div>

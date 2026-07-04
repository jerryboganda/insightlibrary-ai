<script lang="ts">
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import { FileText, Upload, CheckCircle2, Loader2, AlertTriangle } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, PageHeader, Button, Badge, Skeleton } from '$lib/components/ui';

	const id = $derived(page.params.id ?? '');
	const query = $derived(
		createQuery({ queryKey: ['folder', id], queryFn: () => api.getFolder(id) })
	);

	const statusMeta = (status: string) => {
		switch (status) {
			case 'indexed':
				return { icon: CheckCircle2, tone: 'emerald' as const };
			case 'processing':
				return { icon: Loader2, tone: 'amber' as const };
			case 'needs_review':
				return { icon: AlertTriangle, tone: 'rose' as const };
			default:
				return { icon: FileText, tone: 'zinc' as const };
		}
	};
</script>

{#if $query.isLoading}
	<div class="mx-auto max-w-5xl space-y-4"><Skeleton class="h-10 w-64" /><Skeleton class="h-40" /></div>
{:else if $query.data}
	{@const folder = $query.data.folder}
	<div class="mx-auto max-w-5xl space-y-6">
		<PageHeader title={folder.name} description="{folder.docs} documents · {folder.topics} topics · {folder.health}% SSOT health">
			{#snippet actions()}
				<Button href="/folders/{id}/upload"><Upload class="h-4 w-4" /> Upload</Button>
			{/snippet}
		</PageHeader>

		<Card>
			<div class="border-b border-zinc-800 px-4 py-3 text-sm font-medium text-zinc-300">Documents</div>
			<div class="divide-y divide-zinc-800/60">
				{#each $query.data.documents as doc (doc.id)}
					{@const meta = statusMeta(doc.status)}
					<a href="/folders/{id}/{doc.id}" class="flex items-center justify-between px-4 py-3 transition-colors hover:bg-zinc-900/40">
						<div class="flex items-center gap-3">
							<div class="rounded bg-zinc-800/80 p-2 text-zinc-400"><FileText class="h-4 w-4" /></div>
							<div>
								<div class="text-sm text-zinc-200">{doc.title}</div>
								<div class="text-xs text-zinc-500">{doc.type.toUpperCase()} · {doc.pages} pages · {doc.topics} topics</div>
							</div>
						</div>
						<Badge tone={meta.tone}><meta.icon class="h-3 w-3" /> {doc.statusLabel}</Badge>
					</a>
				{/each}
				{#if $query.data.documents.length === 0}
					<div class="px-4 py-8 text-center text-sm text-zinc-500">No documents yet. Upload one to begin ingestion.</div>
				{/if}
			</div>
		</Card>
	</div>
{:else}
	<div class="mx-auto max-w-5xl py-16 text-center text-zinc-500">Folder not found.</div>
{/if}

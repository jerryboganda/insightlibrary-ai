<script lang="ts">
	import { page } from '$app/state';
	import { createQuery } from '@tanstack/svelte-query';
	import { fade } from 'svelte/transition';
	import {
		FileText,
		Activity,
		Fingerprint,
		CheckCircle2,
		ChevronLeft,
		Map,
		Network,
		RefreshCw,
		ExternalLink,
		Loader2,
		AlertTriangle
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Card, Button, Skeleton } from '$lib/components/ui';

	// Dynamic route params — always present when this route matches.
	const folderId = $derived(page.params.id!);
	const docId = $derived(page.params.docId!);
	const query = $derived(
		createQuery({ queryKey: ['document', docId], queryFn: () => api.getDocument(docId) })
	);

	// Prototype-specific extraction/pipeline detail has no API endpoint — inlined.
	const extractionStats = [
		{ label: 'Total Chunks', value: '14,205' },
		{ label: 'Claims Extracted', value: '8,430' },
		{ label: 'Topics Enriched', value: '1,240' },
		{ label: 'Graph Nodes Generated', value: '6,102' }
	];

	const processingStages = [
		{ name: 'Upload & Fingerprint', status: 'complete', time: '12s' },
		{ name: 'OCR & Text Extraction', status: 'complete', time: '2m 15s' },
		{ name: 'Table & Figure Detection', status: 'complete', time: '45s' },
		{ name: 'Chunking & Embeddings', status: 'complete', time: '1m 30s' },
		{ name: 'Graph Community Extraction', status: 'complete', time: '3m 10s' },
		{ name: 'Delta SSOT Merging', status: 'complete', time: '1m 05s' }
	];

	const raptorSummary = [
		'This document serves as a foundational text for systemic pathology. The overarching themes involve cellular responses to stress and toxic insults, adaptation, injury, and death. It extensively covers inflammation, tissue repair, hemodynamic disorders, thromboembolic disease, and shock.',
		'Significant chapters expand on diseases of immunity, neoplasia, genetic and pediatric diseases, and environmental and nutritional diseases. The document provides dense extraction targets for the topic canonicalization engine, particularly yielding high confidence definitions, pathophysiological mechanisms, and morphological findings.'
	];

	const topicsDetected = [
		{ name: "Addison's Disease", relevance: 0.95 },
		{ name: 'Cushing Syndrome', relevance: 0.92 },
		{ name: 'Diabetes Mellitus', relevance: 0.98 }
	];

	const slug = (s: string) => s.toLowerCase().replace(/ /g, '-');
</script>

<div class="mx-auto max-w-6xl space-y-8">
	<div>
		<a
			href="/folders/{folderId}"
			class="flex w-fit items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
		>
			<ChevronLeft class="h-4 w-4" /> Back to Folder
		</a>
	</div>

	{#if $query.isLoading}
		<div class="space-y-6">
			<Skeleton class="h-24 w-full" />
			<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
				<Skeleton class="h-80 lg:col-span-1" />
				<Skeleton class="h-80 lg:col-span-2" />
			</div>
		</div>
	{:else if $query.data}
		{@const doc = $query.data}
		<div in:fade={{ duration: 200 }} class="space-y-8">
			<!-- Header -->
			<div class="flex flex-col justify-between gap-6 md:flex-row md:items-start">
				<div class="flex items-start gap-4">
					<div
						class="flex h-20 w-16 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 shadow-xl"
					>
						<FileText class="h-8 w-8 text-indigo-400/50" />
					</div>
					<div>
						<h1 class="text-2xl font-bold tracking-tight text-zinc-100">{doc.title}</h1>
						<p class="mt-1 text-zinc-400">
							{doc.type.toUpperCase()} · {doc.pages.toLocaleString()} pages · {doc.topics} topics
						</p>
						<div class="mt-3 flex items-center gap-3">
							<span
								class="flex items-center gap-1 rounded border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-400"
							>
								<CheckCircle2 class="h-3.5 w-3.5" />
								{doc.statusLabel}
							</span>
							<span class="font-mono text-xs text-zinc-500">
								<Fingerprint class="mr-1 inline h-3 w-3" />Hash: a8f4…91c2
							</span>
						</div>
					</div>
				</div>
				<div class="flex items-center gap-3">
					<Button variant="outline">
						<ExternalLink class="h-4 w-4" /> View Source File
					</Button>
					<Button>
						<RefreshCw class="h-4 w-4" /> Re-Index Document
					</Button>
				</div>
			</div>

			<div class="grid grid-cols-1 gap-6 lg:grid-cols-3">
				<!-- Left: Stats & Pipeline -->
				<div class="space-y-6 lg:col-span-1">
					<Card class="p-5">
						<h3
							class="mb-4 flex items-center gap-2 border-b border-zinc-800/50 pb-2 text-sm font-medium text-zinc-400"
						>
							<Activity class="h-4 w-4 text-indigo-400" /> Knowledge Extraction Stats
						</h3>
						<div class="space-y-4">
							{#each extractionStats as stat (stat.label)}
								<div class="flex items-end justify-between">
									<span class="text-sm text-zinc-400">{stat.label}</span>
									<span class="font-mono text-zinc-200">{stat.value}</span>
								</div>
							{/each}
						</div>
					</Card>

					<Card class="p-5">
						<h3 class="mb-4 border-b border-zinc-800/50 pb-2 text-sm font-medium text-zinc-400">
							Processing Pipeline
						</h3>
						<div class="space-y-4">
							{#each processingStages as stage (stage.name)}
								<div class="flex items-start gap-3">
									<div class="mt-0.5">
										{#if stage.status === 'complete'}
											<CheckCircle2 class="h-4 w-4 text-emerald-400" />
										{:else if stage.status === 'running'}
											<Loader2 class="h-4 w-4 animate-spin text-amber-400" />
										{:else}
											<div class="h-4 w-4 rounded-full border-2 border-zinc-700"></div>
										{/if}
									</div>
									<div>
										<p class="text-sm font-medium text-zinc-300">{stage.name}</p>
										<p class="font-mono text-xs text-zinc-500">{stage.time}</p>
									</div>
								</div>
							{/each}
						</div>
					</Card>
				</div>

				<!-- Right: Summary & Topics -->
				<div class="space-y-6 lg:col-span-2">
					<Card class="overflow-hidden">
						<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-5 py-4">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
								<Map class="h-4 w-4 text-emerald-400" /> RAPTOR Document Summary
							</h3>
						</div>
						<div class="space-y-4 p-5 text-sm leading-relaxed text-zinc-300">
							{#each raptorSummary as para, i (i)}
								<p>{para}</p>
							{/each}
						</div>
					</Card>

					<Card class="overflow-hidden">
						<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-5 py-4">
							<h3 class="flex items-center gap-2 text-sm font-medium text-zinc-200">
								<Network class="h-4 w-4 text-indigo-400" /> Top Detected Topics
							</h3>
						</div>
						<div class="overflow-x-auto">
							<table class="w-full text-left text-sm">
								<thead
									class="border-b border-zinc-800/50 bg-zinc-950/50 text-xs font-medium text-zinc-500"
								>
									<tr>
										<th class="px-5 py-3">Topic Name</th>
										<th class="px-5 py-3">Relevance</th>
										<th class="px-5 py-3 text-right">Action</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-zinc-800/50">
									{#each topicsDetected as topic (topic.name)}
										<tr class="transition-colors hover:bg-zinc-900/40">
											<td class="px-5 py-3 font-medium text-zinc-300">{topic.name}</td>
											<td class="px-5 py-3">
												<div class="flex items-center gap-2">
													<div class="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800">
														<div
															class="h-full rounded-full bg-indigo-500"
															style="width: {topic.relevance * 100}%"
														></div>
													</div>
													<span class="font-mono text-xs text-zinc-400"
														>{Math.round(topic.relevance * 100)}%</span
													>
												</div>
											</td>
											<td class="px-5 py-3 text-right">
												<a
													href="/topics/{slug(topic.name)}"
													class="text-xs font-medium text-indigo-400 hover:text-indigo-300"
													>View SSOT →</a
												>
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</Card>
				</div>
			</div>
		</div>
	{:else}
		<div
			class="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-800 py-16 text-center"
		>
			<AlertTriangle class="h-8 w-8 text-zinc-600" />
			<p class="text-sm text-zinc-500">Document not found.</p>
			<a href="/folders/{folderId}" class="text-sm text-indigo-400 hover:text-indigo-300"
				>Return to folder →</a
			>
		</div>
	{/if}
</div>

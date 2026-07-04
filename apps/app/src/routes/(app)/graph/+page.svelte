<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade, fly, scale } from 'svelte/transition';
	import {
		Network,
		ZoomIn,
		ZoomOut,
		Maximize,
		Filter,
		X,
		GitMerge,
		Activity,
		Loader2
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { cn } from '$lib/utils';
	import type { GraphNode, GraphEdge } from '@insightlibrary/schemas';

	const graph = createQuery({ queryKey: ['graph'], queryFn: () => api.getGraph() });

	// ── View controls (client-side, deterministic) ────────────────────────────
	const subgraphs = ["Addison's Subgraph", 'USMLE Step 1', 'Global'] as const;
	let activeSubgraph = $state<(typeof subgraphs)[number]>(subgraphs[0]);
	let zoom = $state(1);
	let selectedId = $state<string | null>(null);
	let activeGroups = $state<Set<string>>(new Set());
	let showFilter = $state(false);

	// Visual metadata per node group. Central "Disease" node anchors the radial layout.
	const groupMeta: Record<
		string,
		{ label: string; dot: string; node: string; stroke: string; text: string }
	> = {
		Disease: {
			label: 'Disease',
			dot: 'bg-rose-500 text-rose-500',
			node: 'bg-rose-500/20 text-rose-300 border-rose-500/50 shadow-rose-500/40',
			stroke: '#f43f5e',
			text: 'text-rose-300'
		},
		Anatomy: {
			label: 'Anatomy',
			dot: 'bg-blue-500 text-blue-500',
			node: 'bg-blue-500/20 text-blue-300 border-blue-500/50 shadow-blue-500/40',
			stroke: '#3b82f6',
			text: 'text-blue-300'
		},
		Hormone: {
			label: 'Hormone',
			dot: 'bg-emerald-500 text-emerald-500',
			node: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50 shadow-emerald-500/40',
			stroke: '#10b981',
			text: 'text-emerald-300'
		},
		Symptom: {
			label: 'Symptom',
			dot: 'bg-amber-500 text-amber-500',
			node: 'bg-amber-500/20 text-amber-300 border-amber-500/50 shadow-amber-500/40',
			stroke: '#f59e0b',
			text: 'text-amber-300'
		},
		Etiology: {
			label: 'Etiology',
			dot: 'bg-purple-500 text-purple-500',
			node: 'bg-purple-500/20 text-purple-300 border-purple-500/50 shadow-purple-500/40',
			stroke: '#a855f7',
			text: 'text-purple-300'
		}
	};

	function meta(group: string) {
		return (
			groupMeta[group] ?? {
				label: group,
				dot: 'bg-zinc-500 text-zinc-500',
				node: 'bg-zinc-800 text-zinc-300 border-zinc-600 shadow-zinc-700/40',
				stroke: '#71717a',
				text: 'text-zinc-300'
			}
		);
	}

	const legend = $derived.by(() => {
		const seen = new Map<string, number>();
		for (const n of $graph.data?.nodes ?? []) seen.set(n.group, (seen.get(n.group) ?? 0) + 1);
		// Keep a stable, meaningful order matching the prototype legend.
		const order = ['Disease', 'Anatomy', 'Hormone', 'Symptom', 'Etiology'];
		const groups = [...seen.keys()].sort((a, b) => {
			const ai = order.indexOf(a);
			const bi = order.indexOf(b);
			return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
		});
		return groups.map((g) => ({ group: g, count: seen.get(g) ?? 0, ...meta(g) }));
	});

	// ── Deterministic radial layout ────────────────────────────────────────────
	// Nodes with the highest degree (most edges) anchor to the centre; the rest
	// fan out evenly on a circle by their index. No randomness, no external lib.
	const layout = $derived.by(() => {
		const nodes = $graph.data?.nodes ?? [];
		const edges = $graph.data?.edges ?? [];
		if (nodes.length === 0) return { pos: new Map<string, { x: number; y: number }>(), nodes, edges };

		const degree = new Map<string, number>();
		for (const n of nodes) degree.set(n.id, 0);
		for (const e of edges) {
			degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
			degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
		}

		// Highest-degree node → centre. Ties broken by original array order (stable).
		let centreIdx = 0;
		let best = -1;
		nodes.forEach((n, i) => {
			const d = degree.get(n.id) ?? 0;
			if (d > best) {
				best = d;
				centreIdx = i;
			}
		});

		const spokes = nodes.filter((_, i) => i !== centreIdx);
		const pos = new Map<string, { x: number; y: number }>();
		pos.set(nodes[centreIdx].id, { x: 50, y: 50 });

		const radius = 36; // percent of canvas
		const count = Math.max(spokes.length, 1);
		spokes.forEach((n, i) => {
			// Start at top (-90deg) and distribute evenly around the circle.
			const angle = (-90 + (360 / count) * i) * (Math.PI / 180);
			pos.set(n.id, {
				x: 50 + Math.cos(angle) * radius,
				y: 50 + Math.sin(angle) * (radius * 0.82) // slightly flatten for 16:9 canvas
			});
		});

		return { pos, nodes, edges };
	});

	function visible(group: string): boolean {
		return activeGroups.size === 0 || activeGroups.has(group);
	}

	function toggleGroup(group: string) {
		const next = new Set(activeGroups);
		if (next.has(group)) next.delete(group);
		else next.add(group);
		activeGroups = next;
	}

	const nodeById = $derived(new Map(($graph.data?.nodes ?? []).map((n) => [n.id, n])));

	const selectedNode = $derived<GraphNode | null>(
		selectedId ? (nodeById.get(selectedId) ?? null) : null
	);

	const selectedEdges = $derived.by<Array<GraphEdge & { dir: 'out' | 'in'; other: string }>>(() => {
		if (!selectedId) return [];
		const out: Array<GraphEdge & { dir: 'out' | 'in'; other: string }> = [];
		for (const e of $graph.data?.edges ?? []) {
			if (e.source === selectedId) out.push({ ...e, dir: 'out', other: e.target });
			else if (e.target === selectedId) out.push({ ...e, dir: 'in', other: e.source });
		}
		return out;
	});

	function isEdgeHighlighted(e: GraphEdge): boolean {
		return !!selectedId && (e.source === selectedId || e.target === selectedId);
	}

	function select(id: string) {
		selectedId = selectedId === id ? null : id;
	}

	const zoomIn = () => (zoom = Math.min(2, +(zoom + 0.2).toFixed(2)));
	const zoomOut = () => (zoom = Math.max(0.5, +(zoom - 0.2).toFixed(2)));
	const resetZoom = () => (zoom = 1);
</script>

<div class="flex h-full w-full flex-col">
	<!-- Controls Bar -->
	<div
		class="relative z-20 flex h-14 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950/50 px-4"
	>
		<div class="flex items-center gap-3">
			<div class="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 p-1">
				{#each subgraphs as sub (sub)}
					<button
						onclick={() => (activeSubgraph = sub)}
						class={cn(
							'rounded px-3 py-1 text-xs font-medium transition-colors',
							activeSubgraph === sub
								? 'bg-zinc-800 text-zinc-200 shadow-sm'
								: 'text-zinc-500 hover:text-zinc-300'
						)}
					>
						{sub}
					</button>
				{/each}
			</div>
		</div>

		<div class="flex items-center gap-2">
			<div class="relative">
				<button
					onclick={() => (showFilter = !showFilter)}
					title="Filter Nodes"
					class={cn(
						'rounded border border-zinc-800 p-2 transition-colors',
						showFilter || activeGroups.size > 0
							? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
							: 'bg-zinc-950 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
					)}
				>
					<Filter class="h-4 w-4" />
				</button>
				{#if showFilter}
					<div
						class="glass-panel absolute top-11 right-0 z-30 w-48 space-y-1 rounded-xl border border-zinc-800 p-2"
						transition:fly={{ y: -6, duration: 150 }}
					>
						<p class="px-2 py-1 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
							Filter by type
						</p>
						{#each legend as l (l.group)}
							<button
								onclick={() => toggleGroup(l.group)}
								class={cn(
									'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs transition-colors',
									activeGroups.size === 0 || activeGroups.has(l.group)
										? 'text-zinc-200 hover:bg-zinc-800/70'
										: 'text-zinc-600 hover:bg-zinc-800/40'
								)}
							>
								<span class="flex items-center gap-2">
									<span class={cn('h-2.5 w-2.5 rounded-full', l.dot.split(' ')[0])}></span>
									{l.label}
								</span>
								<span class="font-mono text-[10px] text-zinc-500">{l.count}</span>
							</button>
						{/each}
						{#if activeGroups.size > 0}
							<button
								onclick={() => (activeGroups = new Set())}
								class="w-full rounded-md px-2 py-1.5 text-left text-[11px] text-indigo-400 hover:bg-zinc-800/70"
							>
								Clear filters
							</button>
						{/if}
					</div>
				{/if}
			</div>
			<div class="mx-1 h-6 w-px bg-zinc-800"></div>
			<button
				onclick={zoomOut}
				title="Zoom out"
				class="rounded-l border border-zinc-800 bg-zinc-950 p-2 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
			>
				<ZoomOut class="h-4 w-4" />
			</button>
			<button
				onclick={zoomIn}
				title="Zoom in"
				class="border-y border-zinc-800 bg-zinc-950 p-2 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
			>
				<ZoomIn class="h-4 w-4" />
			</button>
			<button
				onclick={resetZoom}
				title="Reset view"
				class="rounded-r border border-zinc-800 bg-zinc-950 p-2 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-200"
			>
				<Maximize class="h-4 w-4" />
			</button>
		</div>
	</div>

	<!-- Canvas + side panel -->
	<div class="relative flex min-h-0 flex-1">
		<!-- Graph Visualization Canvas -->
		<div class="relative flex-1 overflow-hidden bg-[#09090b]">
			<!-- Background dot pattern -->
			<div
				class="pointer-events-none absolute inset-0 opacity-[0.03]"
				style="background-image: radial-gradient(#fff 1px, transparent 1px); background-size: 24px 24px;"
			></div>

			<!-- Zoom / reset badge -->
			<div
				class="absolute top-4 left-4 z-10 rounded-md border border-zinc-800 bg-zinc-950/70 px-2.5 py-1 font-mono text-[10px] text-zinc-500"
			>
				zoom {(zoom * 100).toFixed(0)}%
			</div>

			<!-- Legend -->
			<div
				class="glass-panel absolute bottom-6 left-6 z-10 space-y-2 rounded-xl border border-zinc-800 p-4"
			>
				<h4 class="mb-3 text-xs font-semibold tracking-wider text-zinc-300 uppercase">Node Types</h4>
				{#if $graph.isLoading}
					{#each ['Disease', 'Anatomy', 'Hormone', 'Symptom', 'Etiology'] as l (l)}
						<div class="flex items-center gap-2 text-xs text-zinc-600">
							<span class="h-2.5 w-2.5 rounded-full bg-zinc-700"></span>
							{l}
						</div>
					{/each}
				{:else}
					{#each legend as l (l.group)}
						<button
							onclick={() => toggleGroup(l.group)}
							class={cn(
								'flex w-full items-center gap-2 text-xs transition-colors',
								visible(l.group) ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-600'
							)}
						>
							<span
								class={cn(
									'h-2.5 w-2.5 rounded-full shadow-[0_0_8px_currentColor]',
									l.dot.split(' ')[0],
									l.dot.split(' ')[1]
								)}
							></span>
							{l.label}
							<span class="ml-auto font-mono text-[10px] text-zinc-600">{l.count}</span>
						</button>
					{/each}
				{/if}
			</div>

			<!-- Loading state -->
			{#if $graph.isLoading}
				<div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500">
					<Loader2 class="h-6 w-6 animate-spin text-indigo-400" />
					<p class="text-sm">Building knowledge graph…</p>
				</div>
			{:else if $graph.isError}
				<div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500">
					<div class="rounded-full border border-rose-500/20 bg-rose-500/10 p-3">
						<Network class="h-6 w-6 text-rose-400" />
					</div>
					<p class="text-sm text-rose-400">Failed to load the knowledge graph.</p>
				</div>
			{:else if layout.nodes.length === 0}
				<div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500">
					<div class="rounded-full border border-zinc-800 bg-zinc-900 p-3">
						<Network class="h-6 w-6 text-zinc-600" />
					</div>
					<p class="text-sm">No entities in this subgraph yet.</p>
				</div>
			{:else}
				<!-- Interactive graph area -->
				<div class="absolute inset-0 flex items-center justify-center">
					<div
						class="relative aspect-video w-full max-w-4xl transition-transform duration-200"
						style="transform: scale({zoom});"
					>
						<!-- Edges -->
						<svg class="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
							{#each layout.edges as edge, i (edge.source + '->' + edge.target + i)}
								{@const s = layout.pos.get(edge.source)}
								{@const t = layout.pos.get(edge.target)}
								{@const shown =
									!!s &&
									!!t &&
									visible(nodeById.get(edge.source)?.group ?? '') &&
									visible(nodeById.get(edge.target)?.group ?? '')}
								{#if s && t && shown}
									{@const hot = isEdgeHighlighted(edge)}
									<g opacity={selectedId && !hot ? 0.25 : 1} class="transition-opacity">
										<line
											x1="{s.x}%"
											y1="{s.y}%"
											x2="{t.x}%"
											y2="{t.y}%"
											stroke={hot ? '#818cf8' : '#3f3f46'}
											stroke-width={hot ? 1.75 : 1}
											stroke-dasharray="4 4"
										/>
										<text
											x="{(s.x + t.x) / 2}%"
											y="{(s.y + t.y) / 2}%"
											fill={hot ? '#a5b4fc' : '#71717a'}
											font-size="10"
											text-anchor="middle"
											dy="-5"
											class="font-mono"
										>
											{edge.label}
										</text>
									</g>
								{/if}
							{/each}
						</svg>

						<!-- Nodes -->
						{#each layout.nodes as node (node.id)}
							{@const pos = layout.pos.get(node.id)}
							{@const m = meta(node.group)}
							{@const shown = visible(node.group)}
							{@const isSel = selectedId === node.id}
							{@const dim = !!selectedId && !isSel && !selectedEdges.some((e) => e.other === node.id)}
							{#if pos}
								<button
									type="button"
									onclick={() => select(node.id)}
									class={cn(
										'group absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-1 transition-opacity',
										shown ? 'cursor-pointer' : 'pointer-events-none opacity-15',
										dim && shown ? 'opacity-40' : ''
									)}
									style="left: {pos.x}%; top: {pos.y}%;"
									in:scale={{ duration: 200, start: 0.6 }}
								>
									<div
										class={cn(
											'flex items-center justify-center rounded-full border shadow-lg backdrop-blur-md transition-transform group-hover:scale-110',
											m.node,
											isSel ? 'scale-110 ring-2 ring-indigo-400 ring-offset-2 ring-offset-[#09090b]' : ''
										)}
										style="width: {node.size * 2}px; height: {node.size * 2}px;"
									>
										<Network class="h-4 w-4 opacity-70" />
									</div>
									<span
										class={cn(
											'rounded border border-zinc-800 bg-zinc-950/80 px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-opacity',
											isSel
												? 'text-zinc-100 opacity-100'
												: 'text-zinc-300 opacity-80 group-hover:opacity-100'
										)}
									>
										{node.id}
									</span>
								</button>
							{/if}
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Side detail panel -->
		{#if selectedNode}
			{@const m = meta(selectedNode.group)}
			<aside
				class="relative z-10 flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/70"
				transition:fly={{ x: 24, duration: 200 }}
			>
				<div class="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
					<div class="flex items-center gap-3">
						<div
							class={cn(
								'flex h-10 w-10 items-center justify-center rounded-lg border shadow-lg',
								m.node
							)}
						>
							<Network class="h-5 w-5 opacity-80" />
						</div>
						<div>
							<h3 class="text-sm font-semibold text-zinc-100">{selectedNode.id}</h3>
							<span class={cn('text-xs font-medium', m.text)}>{selectedNode.group}</span>
						</div>
					</div>
					<button
						onclick={() => (selectedId = null)}
						aria-label="Close panel"
						class="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
					>
						<X class="h-4 w-4" />
					</button>
				</div>

				<div class="flex-1 space-y-6 overflow-y-auto px-5 py-5">
					<!-- Metrics -->
					<div class="grid grid-cols-2 gap-3">
						<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
							<div class="flex items-center gap-1.5 text-[10px] tracking-wider text-zinc-500 uppercase">
								<GitMerge class="h-3 w-3" /> Relations
							</div>
							<p class="mt-1 font-mono text-lg text-zinc-100">{selectedEdges.length}</p>
						</div>
						<div class="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
							<div class="flex items-center gap-1.5 text-[10px] tracking-wider text-zinc-500 uppercase">
								<Activity class="h-3 w-3" /> Weight
							</div>
							<p class="mt-1 font-mono text-lg text-zinc-100">{selectedNode.size}</p>
						</div>
					</div>

					<!-- Connected relationships -->
					<div>
						<h4 class="mb-2 text-[10px] font-semibold tracking-wider text-zinc-500 uppercase">
							Relationships
						</h4>
						<div class="space-y-2">
							{#each selectedEdges as e (e.source + e.target + e.label)}
								{@const om = meta(nodeById.get(e.other)?.group ?? '')}
								<button
									onclick={() => select(e.other)}
									class="flex w-full items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-left transition-colors hover:border-indigo-500/40 hover:bg-zinc-900"
								>
									<span class={cn('h-2 w-2 shrink-0 rounded-full', om.dot.split(' ')[0])}></span>
									<div class="min-w-0 flex-1">
										<p class="truncate text-xs font-medium text-zinc-200">{e.other}</p>
										<p class="font-mono text-[10px] text-zinc-500">
											{e.dir === 'out' ? '→' : '←'}
											{e.label}
										</p>
									</div>
								</button>
							{:else}
								<p class="text-xs text-zinc-600">No relationships in this subgraph.</p>
							{/each}
						</div>
					</div>
				</div>

				<div class="border-t border-zinc-800 px-5 py-3">
					<p class="font-mono text-[10px] text-zinc-600">
						node_id: {selectedNode.id.toLowerCase().replace(/\s+/g, '_')}
					</p>
				</div>
			</aside>
		{:else if !$graph.isLoading && layout.nodes.length > 0}
			<!-- Idle hint panel -->
			<aside
				class="relative z-10 hidden w-80 shrink-0 flex-col items-center justify-center gap-3 border-l border-zinc-800 bg-zinc-950/40 px-6 text-center lg:flex"
				in:fade={{ duration: 150 }}
			>
				<div class="rounded-full border border-zinc-800 bg-zinc-900/60 p-3">
					<Network class="h-6 w-6 text-zinc-600" />
				</div>
				<p class="text-sm text-zinc-400">Select a node</p>
				<p class="max-w-[16rem] text-xs text-zinc-600">
					Click any entity in the graph to inspect its group, weight, and relationships.
				</p>
			</aside>
		{/if}
	</div>
</div>

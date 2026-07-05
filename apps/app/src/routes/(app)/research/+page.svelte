<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import {
		Library,
		Plus,
		FileText,
		BookOpen,
		Link2,
		Network,
		Clock,
		Table2,
		FileStack,
		ChevronRight,
		FlaskConical
	} from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { Card, PageHeader, Button, Badge } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// The Research Workspace is a page-specific hub with no dedicated API endpoint —
	// the tool cards, pinned sources, and evidence cards are inlined from the prototype.
	type Tool = {
		id: string;
		href: string;
		title: string;
		description: string;
		icon: typeof Network;
		accent: string;
		iconBg: string;
	};
	const tools: Tool[] = [
		{
			id: 'argument-map',
			href: '/research/argument-map',
			title: 'Argument Map',
			description:
				'Construct logical arguments from source claims. Draw connections between premises, evidence, and conclusions.',
			icon: Network,
			accent: 'group-hover:border-indigo-500/50',
			iconBg: 'bg-indigo-500/10 text-indigo-400 group-hover:bg-indigo-500/20'
		},
		{
			id: 'compare-matrix',
			href: '/research/compare-matrix',
			title: 'Compare Matrix',
			description:
				'Line up sources side by side to surface agreements, contradictions, and gaps across the literature.',
			icon: Table2,
			accent: 'group-hover:border-emerald-500/50',
			iconBg: 'bg-emerald-500/10 text-emerald-400 group-hover:bg-emerald-500/20'
		},
		{
			id: 'report-builder',
			href: '/research/report-builder',
			title: 'Report Builder',
			description:
				'Assemble a cited synthesis report from evidence cards, then export to PDF, Word, or Markdown.',
			icon: FileStack,
			accent: 'group-hover:border-amber-500/50',
			iconBg: 'bg-amber-500/10 text-amber-400 group-hover:bg-amber-500/20'
		},
		{
			id: 'timeline-builder',
			href: '/research/timeline-builder',
			title: 'Timeline Builder',
			description:
				'Sequence events, findings, and revisions chronologically to trace how understanding evolved.',
			icon: Clock,
			accent: 'group-hover:border-blue-500/50',
			iconBg: 'bg-blue-500/10 text-blue-400 group-hover:bg-blue-500/20'
		}
	];

	type Source = { title: string; context: string; icon: typeof FileText };
	const pinnedSources: Source[] = [
		{ title: 'Book B: Clinical Endo', context: 'Chapter 4: Adrenal', icon: FileText },
		{ title: 'Book D: Board Pearls', context: 'Pages 212-215', icon: FileText },
		{ title: 'Book A: Basic Sciences', context: 'Anatomy Ref', icon: BookOpen }
	];

	type Evidence = {
		kind: 'Claim' | 'Concept' | 'Conflict';
		text: string;
		citation: string;
		needsResolution?: boolean;
	};
	const evidenceCards: Evidence[] = [
		{
			kind: 'Claim',
			text: 'Tuberculosis is still the most common cause globally, despite autoimmune prevailing in developed countries.',
			citation: 'bk-A p22, bk-D p208'
		},
		{
			kind: 'Concept',
			text: 'Hyperpigmentation is the crucial clinical differentiator between primary and secondary adrenal insufficiency.',
			citation: 'Linked to ACTH/POMC elevation'
		},
		{
			kind: 'Conflict',
			text: 'Dosing regimen discrepancy: twice daily vs thrice daily hydrocortisone administration.',
			citation: 'bk-B vs bk-D',
			needsResolution: true
		}
	];

	const kindTone: Record<Evidence['kind'], string> = {
		Claim: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/20',
		Concept: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/20',
		Conflict: 'bg-rose-500/20 text-rose-300 border-rose-500/20'
	};

	// Pinned-source toggle: membership in this set drives the visual pinned state.
	// Seed it with the sources that ship pinned so their state reflects reality.
	let pinned = $state<Set<string>>(new Set(pinnedSources.map((s) => s.title)));
	function togglePin(title: string) {
		const next = new Set(pinned);
		if (next.has(title)) next.delete(title);
		else next.add(title);
		pinned = next;
	}

	// Short-lived notice shown near the Extract Claim action.
	let notice = $state('');
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	function flashNotice(msg: string) {
		notice = msg;
		clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => (notice = ''), 2500);
	}
</script>

<div class="mx-auto max-w-6xl space-y-8">
	<PageHeader
		title="Research Workspace"
		description="Curate evidence cards, analyze contradictions, and synthesize knowledge across multiple sources."
	>
		{#snippet actions()}
			<Button>
				<Plus class="h-4 w-4" /> New Research Board
			</Button>
		{/snippet}
	</PageHeader>

	<!-- Active board banner -->
	<div
		in:fade={{ duration: 200 }}
		class="flex items-center gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3"
	>
		<div
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400"
		>
			<Library class="h-5 w-5" />
		</div>
		<div class="min-w-0 flex-1">
			<p class="text-sm font-semibold text-zinc-100">Adrenal Insufficiency Synthesis</p>
			<p class="text-xs text-zinc-500">3 pinned sources · 4 evidence cards · 1 unresolved conflict</p>
		</div>
		<Badge tone="indigo">Active board</Badge>
	</div>

	<!-- Tools grid -->
	<section class="space-y-4">
		<h2 class="text-sm font-semibold tracking-wide text-zinc-300 uppercase">Research Tools</h2>
		<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
			{#each tools as tool, i (tool.id)}
				<a
					href={tool.href}
					in:fly={{ y: 8, duration: 200, delay: i * 40 }}
					class={cn(
						'group flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-5 backdrop-blur-sm transition-colors hover:bg-zinc-900/40',
						tool.accent
					)}
				>
					<div class="flex items-start justify-between">
						<div
							class={cn(
								'flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
								tool.iconBg
							)}
						>
							<tool.icon class="h-5 w-5" />
						</div>
						<ChevronRight
							class="h-4 w-4 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-400"
						/>
					</div>
					<div>
						<h3 class="text-base font-semibold text-zinc-100">{tool.title}</h3>
						<p class="mt-1 text-sm leading-relaxed text-zinc-400">{tool.description}</p>
					</div>
				</a>
			{/each}
		</div>
	</section>

	<!-- Board detail: sources + evidence -->
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<!-- Pinned Sources -->
		<Card class="flex flex-col">
			<div
				class="flex items-center justify-between rounded-t-xl border-b border-zinc-800 bg-zinc-900/40 px-4 py-3"
			>
				<h3 class="text-sm font-semibold text-zinc-200">Pinned Sources</h3>
				<span class="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
					>{pinnedSources.length}</span
				>
			</div>
			<div class="space-y-3 p-4">
				{#each pinnedSources as src (src.title)}
					<button
						type="button"
						onclick={() => togglePin(src.title)}
						aria-pressed={pinned.has(src.title)}
						class={cn(
							'group block w-full cursor-pointer rounded-lg border bg-zinc-900/60 p-3 text-left transition-colors',
							pinned.has(src.title)
								? 'border-indigo-500/40 bg-indigo-500/5'
								: 'border-zinc-800 hover:border-indigo-500/30'
						)}
					>
						<div class="flex items-start gap-3">
							<div
								class={cn(
									'flex h-8 w-8 shrink-0 items-center justify-center rounded transition-colors',
									pinned.has(src.title)
										? 'bg-indigo-500/20 text-indigo-300'
										: 'bg-zinc-800 text-zinc-400'
								)}
							>
								<src.icon class="h-4 w-4" />
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<h4 class="text-xs font-semibold text-zinc-200 group-hover:text-indigo-300">
										{src.title}
									</h4>
									{#if pinned.has(src.title)}
										<span
											class="rounded-full bg-indigo-500/20 px-1.5 text-[9px] font-medium text-indigo-300"
											>Pinned</span
										>
									{/if}
								</div>
								<p class="mt-1 text-[10px] text-zinc-500">{src.context}</p>
							</div>
						</div>
					</button>
				{/each}
				<button
					onclick={() => {
						const next = pinnedSources.find((s) => !pinned.has(s.title));
						if (next) {
							togglePin(next.title);
							flashNotice(`Pinned "${next.title}"`);
						} else {
							flashNotice('All sources are already pinned');
						}
					}}
					class="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-800 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-indigo-500/50 hover:text-indigo-400"
				>
					<Plus class="h-3.5 w-3.5" /> Pin Source
				</button>
				{#if notice}
					<p
						in:fade={{ duration: 150 }}
						class="rounded-lg border border-indigo-500/20 bg-indigo-500/5 px-3 py-2 text-center text-xs text-indigo-300"
					>
						{notice}
					</p>
				{/if}
			</div>
		</Card>

		<!-- Evidence Cards -->
		<Card class="flex flex-col">
			<div
				class="flex items-center justify-between rounded-t-xl border-b border-zinc-800 bg-zinc-900/40 px-4 py-3"
			>
				<h3 class="flex items-center gap-2 text-sm font-semibold text-zinc-200">
					<FlaskConical class="h-4 w-4 text-indigo-400" /> Evidence Cards
				</h3>
				<span class="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
					>{evidenceCards.length}</span
				>
			</div>
			<div class="space-y-3 p-4">
				{#each evidenceCards as ev (ev.text)}
					<div
						class={cn(
							'rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 shadow-sm transition-colors',
							ev.kind === 'Conflict' ? 'hover:border-rose-500/30' : 'hover:border-indigo-500/30'
						)}
					>
						<div class="mb-2 flex items-center gap-1.5">
							<span
								class={cn(
									'rounded border px-1.5 py-0.5 text-[10px] tracking-wider uppercase',
									kindTone[ev.kind]
								)}
							>
								{ev.kind}
							</span>
						</div>
						<p class="mb-3 text-xs leading-relaxed text-zinc-300">{ev.text}</p>
						{#if ev.needsResolution}
							<div class="flex items-center justify-between font-mono text-[10px] text-zinc-500">
								<span>{ev.citation}</span>
								<span class="rounded bg-rose-500/10 px-1 text-rose-400">Needs Resolution</span>
							</div>
						{:else}
							<div class="flex items-center gap-2 font-mono text-[10px] text-zinc-500">
								<Link2 class="h-3 w-3" />
								{ev.citation}
							</div>
						{/if}
					</div>
				{/each}
				<button
					onclick={() => goto('/topics')}
					class="flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-zinc-800 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-indigo-500/50 hover:text-indigo-400"
				>
					<Plus class="h-3.5 w-3.5" /> Extract Claim
				</button>
			</div>
		</Card>
	</div>
</div>

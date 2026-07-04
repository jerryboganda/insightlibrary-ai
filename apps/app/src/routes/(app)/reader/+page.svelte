<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import {
		FileText,
		Search,
		TextSelect,
		Quote,
		BookOpen,
		ListTree,
		ChevronRight,
		Sparkles,
		AlertTriangle,
		Link2
	} from '@lucide/svelte';
	import { Card } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// Reader is a page-specific workspace with no dedicated API endpoint — the
	// sample chapter, outline, and extracted claims are inlined from the prototype.
	const doc = {
		book: 'Book D: Board Pearls (2025)',
		chapter: 'Chapter 4: Endocrinology',
		page: 214,
		rev: 'Book D: Board Pearls Rev 2025'
	};

	type OutlineNode = { id: string; label: string; page: number; active?: boolean; depth?: number };
	const outline: OutlineNode[] = [
		{ id: 'o1', label: 'Adrenal Physiology', page: 208 },
		{ id: 'o2', label: 'Primary Adrenal Insufficiency', page: 214, active: true },
		{ id: 'o2a', label: 'Etiology & Epidemiology', page: 214, depth: 1 },
		{ id: 'o2b', label: 'Clinical Presentation', page: 215, depth: 1 },
		{ id: 'o2c', label: 'Treatment & Management', page: 216, depth: 1 },
		{ id: 'o3', label: 'Secondary Adrenal Insufficiency', page: 219 },
		{ id: 'o4', label: 'Cushing Syndrome', page: 223 },
		{ id: 'o5', label: 'Adrenal Neoplasms', page: 231 }
	];

	type Claim = {
		id: string;
		text: string;
		tone: 'indigo' | 'emerald' | 'amber';
		citation: string;
		note?: string;
		conflict?: boolean;
	};
	const claims: Claim[] = [
		{
			id: 'c1',
			text: 'Autoimmune adrenalitis accounts for 80–90% of primary adrenal insufficiency cases in developed countries.',
			tone: 'indigo',
			citation: 'bk-D · p214'
		},
		{
			id: 'c2',
			text: 'Hyperpigmentation of skin and mucous membranes distinguishes primary from secondary adrenal insufficiency.',
			tone: 'emerald',
			citation: 'bk-D · p214'
		},
		{
			id: 'c3',
			text: 'Recent guidelines suggest 20–30mg/day of hydrocortisone divided into three doses.',
			tone: 'amber',
			citation: 'bk-D · p215',
			conflict: true,
			note: 'Existing SSOT claims "15–25mg/day in two doses".'
		}
	];

	const tools = [
		{ id: 'highlight', icon: TextSelect, title: 'Highlight' },
		{ id: 'quote', icon: Quote, title: 'Extract Quote' },
		{ id: 'ask', icon: Search, title: 'Ask Copilot about selection' },
		{ id: 'explain', icon: FileText, title: 'Explain selected paragraph' },
		{ id: 'summarize', icon: BookOpen, title: 'Summarize current page' },
		{ id: 'mcq', icon: Sparkles, title: 'Generate MCQs from page' }
	];

	let activeTool = $state<string | null>(null);
	let activeClaim = $state<string | null>(null);

	const toneRing: Record<Claim['tone'], string> = {
		indigo: 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200',
		emerald: 'border-emerald-500/50 bg-emerald-500/20 text-emerald-200',
		amber: 'border-amber-500/50 bg-amber-500/20 text-amber-200'
	};
	const toneDot: Record<Claim['tone'], string> = {
		indigo: 'bg-indigo-500',
		emerald: 'bg-emerald-500',
		amber: 'bg-amber-500'
	};
</script>

<div class="-m-6 flex h-[calc(100vh-4rem)] overflow-hidden">
	<!-- Left: Chapter Outline -->
	<aside class="hidden w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/40 lg:flex">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
			<ListTree class="h-4 w-4 text-indigo-400" />
			<span class="text-sm font-medium text-zinc-300">Chapter Outline</span>
		</div>
		<div class="flex-1 overflow-y-auto p-2">
			{#each outline as node (node.id)}
				<button
					class={cn(
						'group flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
						node.depth === 1 && 'pl-7 text-[13px]',
						node.active
							? 'bg-indigo-500/10 text-indigo-300'
							: 'text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200'
					)}
				>
					<span class="truncate">{node.label}</span>
					<span class="ml-2 shrink-0 font-mono text-[10px] text-zinc-600">{node.page}</span>
				</button>
			{/each}
		</div>
		<div class="border-t border-zinc-800 px-4 py-3 text-[11px] text-zinc-600">
			{doc.book}
		</div>
	</aside>

	<!-- Center: Document page -->
	<main class="relative flex-1 overflow-y-auto bg-[#0a0a0c] p-6 md:p-10">
		<div
			in:fade={{ duration: 200 }}
			class="relative mx-auto min-h-full max-w-3xl rounded-sm border border-zinc-800 bg-zinc-950/80 p-8 font-serif text-lg leading-relaxed text-zinc-300 shadow-2xl md:p-12"
		>
			<!-- Floating toolbar -->
			<div class="absolute top-12 -left-14 hidden flex-col gap-2 xl:flex">
				{#each tools as tool, i (tool.id)}
					{#if i === 3}<div class="mx-auto my-1 h-px w-8 bg-zinc-800"></div>{/if}
					<button
						title={tool.title}
						onclick={() => (activeTool = activeTool === tool.id ? null : tool.id)}
						class={cn(
							'rounded-md border p-2 shadow-lg transition-colors',
							activeTool === tool.id
								? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400'
								: 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-indigo-500/50 hover:text-indigo-400'
						)}
					>
						<tool.icon class="h-4 w-4" />
					</button>
				{/each}
			</div>

			<h1 class="mb-6 border-b border-zinc-800 pb-4 font-sans text-3xl font-bold text-zinc-100">
				Primary Adrenal Insufficiency (Addison's Disease)
			</h1>

			<p class="mb-6">
				Primary adrenal insufficiency, commonly known as Addison's disease, occurs when the adrenal
				cortex is damaged, leading to decreased production of cortisol and, often, aldosterone. In
				developed countries, the most common etiology is
				<span
					role="button"
					tabindex="0"
					onclick={() => (activeClaim = 'c1')}
					onkeydown={(e) => e.key === 'Enter' && (activeClaim = 'c1')}
					class={cn(
						'cursor-pointer rounded border-b px-1',
						toneRing.indigo,
						activeClaim === 'c1' && 'ring-1 ring-indigo-400/60'
					)}>autoimmune adrenalitis</span
				>, which accounts for 80–90% of cases. Globally, tuberculosis remains a very significant
				cause.
			</p>

			<p class="mb-6">
				Clinical presentation is often insidious. Patients typically present with fatigue, weight
				loss, gastrointestinal disturbances, and profoundly low blood pressure. A hallmark feature
				distinguishing primary from secondary adrenal insufficiency is
				<span
					role="button"
					tabindex="0"
					onclick={() => (activeClaim = 'c2')}
					onkeydown={(e) => e.key === 'Enter' && (activeClaim = 'c2')}
					class={cn(
						'cursor-pointer rounded border-b px-1',
						toneRing.emerald,
						activeClaim === 'c2' && 'ring-1 ring-emerald-400/60'
					)}>hyperpigmentation</span
				>
				of the skin and mucous membranes, caused by elevated levels of ACTH and POMC
				(pro-opiomelanocortin) from the pituitary attempting to stimulate the failing adrenal glands.
			</p>

			<h2 class="mt-8 mb-4 font-sans text-xl font-semibold text-zinc-200">
				Treatment and Management Pearls
			</h2>

			<p class="mb-6">
				Management requires lifelong glucocorticoid and mineralocorticoid replacement. Historically,
				standard dosing involved two daily doses of hydrocortisone. However, <span
					role="button"
					tabindex="0"
					onclick={() => (activeClaim = 'c3')}
					onkeydown={(e) => e.key === 'Enter' && (activeClaim = 'c3')}
					class={cn(
						'group relative cursor-pointer rounded border-b px-1',
						toneRing.amber,
						activeClaim === 'c3' && 'ring-1 ring-amber-400/60'
					)}
				>
					recent guidelines suggest 20–30mg/day divided into three doses
					<span
						class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-48 -translate-x-1/2 rounded border border-zinc-700 bg-zinc-900 p-2 font-sans text-xs text-zinc-300 opacity-0 shadow-xl transition-opacity group-hover:opacity-100"
					>
						Conflict Detected! Existing SSOT claims "15–25mg/day in two doses".
					</span>
				</span> to better mimic the natural circadian rhythm of cortisol secretion. Fludrocortisone is
				additionally given to replace aldosterone.
			</p>

			<div class="my-8 rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 font-sans text-sm">
				<h3 class="mb-2 flex items-center gap-2 font-semibold text-zinc-200">
					<BookOpen class="h-4 w-4 text-indigo-400" /> Exam Pearl Focus
				</h3>
				<p class="text-zinc-400">
					Always check for associated autoimmune conditions. Addison's disease may occur in
					isolation or as part of Polyglandular Autoimmune Syndrome Type 1 or 2 (APS-1 / APS-2).
				</p>
			</div>

			<div
				class="mt-12 flex items-center justify-between border-t border-zinc-800 pt-6 font-sans text-sm tracking-wide text-zinc-500"
			>
				<span>Page {doc.page}</span>
				<span class="italic">{doc.rev}</span>
			</div>
		</div>
	</main>

	<!-- Right: Extracted claims & citations -->
	<aside class="hidden w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-950/40 xl:flex">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
			<Sparkles class="h-4 w-4 text-indigo-400" />
			<span class="text-sm font-medium text-zinc-300">Extracted Claims</span>
			<span class="ml-auto font-mono text-[10px] text-zinc-600">{claims.length} on page</span>
		</div>
		<div class="flex-1 space-y-3 overflow-y-auto p-4">
			{#each claims as claim (claim.id)}
				<button
					onclick={() => (activeClaim = activeClaim === claim.id ? null : claim.id)}
					class="w-full text-left"
				>
					<Card
						hover
						class={cn(
							'p-3 transition-all',
							activeClaim === claim.id && 'border-indigo-500/50 bg-indigo-500/5'
						)}
					>
						<div class="flex items-start gap-2.5">
							<span
								class={cn('mt-1.5 block h-1.5 w-1.5 shrink-0 rounded-full', toneDot[claim.tone])}
							></span>
							<div class="min-w-0 flex-1">
								<p class="text-[13px] leading-relaxed text-zinc-300">{claim.text}</p>
								<div class="mt-2 flex items-center gap-1.5">
									<Link2 class="h-3 w-3 text-zinc-600" />
									<span class="font-mono text-[10px] text-zinc-500">{claim.citation}</span>
								</div>
								{#if claim.conflict}
									<div
										in:fly={{ y: -4, duration: 150 }}
										class="mt-2 flex items-start gap-1.5 rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1.5"
									>
										<AlertTriangle class="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />
										<span class="text-[11px] leading-snug text-rose-300">{claim.note}</span>
									</div>
								{/if}
							</div>
						</div>
					</Card>
				</button>
			{/each}
		</div>
		<div class="border-t border-zinc-800 p-4">
			<a
				href="/review"
				class="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-indigo-500/40 hover:text-indigo-300"
			>
				<span>Send conflicts to review queue</span>
				<ChevronRight class="h-3.5 w-3.5" />
			</a>
		</div>
	</aside>
</div>

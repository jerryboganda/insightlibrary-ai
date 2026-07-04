<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import {
		LayoutTemplate,
		Save,
		Download,
		PlayCircle,
		Plus,
		MessageSquare,
		CheckSquare,
		Settings,
		Loader2,
		CheckCircle2,
		ChevronLeft
	} from '@lucide/svelte';
	import { Button, Badge } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// The report builder is a page-specific Copilot workspace with no dedicated API
	// endpoint — the prompt, evidence sources and draft preview are inlined from the
	// prototype as local state.
	let prompt = $state(
		"Synthesize a detailed review of Addison's Disease management, specifically highlighting areas where Endocrine Guidelines 2025 contradicts standard board review pearls. Use strict citation mode."
	);

	type Source = { id: string; label: string };
	let sources = $state<Source[]>([
		{ id: 's1', label: 'Research Board: Adrenal Crisis' },
		{ id: 's2', label: "Topic SSOT: Addison's Disease" }
	]);

	function addSource() {
		sources = [
			...sources,
			{ id: `s${Date.now()}`, label: `Evidence Source ${sources.length + 1}` }
		];
	}

	// Preview draft — matches the prototype's serif editor content.
	const draft = {
		title: "Management of Addison's Disease: A Synthesis",
		wordCount: 48,
		citations: 2
	};

	type GenState = 'idle' | 'generating' | 'ready';
	let genState = $state<GenState>('idle');
	let genTimer: ReturnType<typeof setTimeout>;
	function generateDraft() {
		if (genState === 'generating') return;
		genState = 'generating';
		clearTimeout(genTimer);
		genTimer = setTimeout(() => (genState = 'ready'), 1400);
	}

	type SaveState = 'idle' | 'saving' | 'saved';
	let saveState = $state<SaveState>('idle');
	let saveTimer: ReturnType<typeof setTimeout>;
	function saveDraft() {
		if (saveState === 'saving') return;
		saveState = 'saving';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveState = 'saved';
			saveTimer = setTimeout(() => (saveState = 'idle'), 2000);
		}, 700);
	}
</script>

<div class="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-7xl flex-col space-y-6" in:fade={{ duration: 200 }}>
	<a
		href="/research"
		class="flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
	>
		<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
	</a>

	<header class="flex shrink-0 flex-col justify-between gap-4 md:flex-row md:items-end">
		<div>
			<div class="mb-2">
				<Badge tone="indigo">Copilot Orchestrated</Badge>
			</div>
			<h1 class="glow-text flex items-center gap-2 text-2xl font-bold tracking-tight text-zinc-100">
				<LayoutTemplate class="h-6 w-6 text-indigo-400" />
				Research Report Builder
			</h1>
			<p class="mt-1 text-sm text-zinc-400">
				Synthesize pinned evidence, canonical SSOT claims, and graph relationships into a formal
				report.
			</p>
		</div>
		<div class="flex gap-3">
			<Button variant="outline" onclick={saveDraft} disabled={saveState === 'saving'}>
				{#if saveState === 'saving'}
					<Loader2 class="h-4 w-4 animate-spin" /> Saving…
				{:else if saveState === 'saved'}
					<CheckCircle2 class="h-4 w-4" /> Saved
				{:else}
					<Save class="h-4 w-4" /> Save Draft
				{/if}
			</Button>
			<Button onclick={() => {}}>
				<Download class="h-4 w-4" /> Export Document
			</Button>
		</div>
	</header>

	<div class="flex min-h-[500px] flex-1 flex-col gap-6 lg:flex-row">
		<!-- Left: Source Selection & Copilot Instructions -->
		<div class="flex flex-col gap-6 lg:w-1/3">
			<div class="glass-panel flex flex-1 flex-col overflow-hidden rounded-xl border border-zinc-800">
				<div
					class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-4 py-3"
				>
					<h3 class="text-sm font-medium text-zinc-200">Report Instructions</h3>
					<Settings class="h-4 w-4 text-zinc-500" />
				</div>
				<div class="flex flex-1 flex-col space-y-4 p-4">
					<div>
						<label
							for="prompt-goal"
							class="mb-2 block text-xs font-medium tracking-wider text-zinc-400 uppercase"
						>
							Prompt Goal
						</label>
						<textarea
							id="prompt-goal"
							bind:value={prompt}
							placeholder="e.g., 'Draft a literature synthesis comparing the pathophysiology in Book A vs Book B...'"
							class="h-32 w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-300 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none"
						></textarea>
					</div>

					<div>
						<span
							class="mb-2 block text-xs font-medium tracking-wider text-zinc-400 uppercase"
						>
							Selected Sources (Evidence)
						</span>
						<div class="space-y-2">
							{#each sources as source (source.id)}
								<div
									in:fly={{ y: -4, duration: 150 }}
									class="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900 p-2"
								>
									<CheckSquare class="h-4 w-4 shrink-0 text-emerald-400" />
									<span class="flex-1 truncate text-sm text-zinc-300">{source.label}</span>
								</div>
							{/each}
							<button
								onclick={addSource}
								class="flex w-full items-center justify-center gap-2 rounded border border-dashed border-zinc-700 py-2 text-sm text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-300"
							>
								<Plus class="h-4 w-4" /> Add Evidence Source
							</button>
						</div>
					</div>

					<div class="relative mt-auto pt-4">
						<button
							onclick={generateDraft}
							disabled={genState === 'generating'}
							class="flex w-full items-center justify-center gap-2 rounded-md bg-zinc-100 px-4 py-2.5 font-medium text-zinc-900 transition-colors hover:bg-white disabled:pointer-events-none disabled:opacity-70"
						>
							{#if genState === 'generating'}
								<Loader2 class="h-5 w-5 animate-spin" /> Generating…
							{:else}
								<PlayCircle class="h-5 w-5" /> Generate Draft with Copilot
							{/if}
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Right: Editor -->
		<div
			class="glass-panel relative flex flex-col overflow-hidden rounded-xl border border-zinc-800 lg:w-2/3"
		>
			<div
				class="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2 font-mono text-xs text-zinc-500"
			>
				<span class={genState === 'generating' ? 'text-amber-400' : 'text-emerald-400'}>●</span>
				{genState === 'generating' ? 'Generating…' : 'Editor Ready'}
				<span class="mx-2">|</span>
				<span>Word Count: {draft.wordCount}</span>
				<span class="mx-2">|</span>
				<span>Citations: {draft.citations} validated</span>
			</div>
			<div class="min-h-[400px] flex-1 overflow-y-auto bg-zinc-950/50 p-8">
				{#if genState === 'generating'}
					<div class="mx-auto max-w-2xl space-y-4">
						<div class="h-8 w-2/3 animate-pulse rounded bg-zinc-800/60"></div>
						<div class="h-4 w-full animate-pulse rounded bg-zinc-800/40"></div>
						<div class="h-4 w-11/12 animate-pulse rounded bg-zinc-800/40"></div>
						<div class="h-4 w-4/5 animate-pulse rounded bg-zinc-800/40"></div>
					</div>
				{:else}
					<div class="mx-auto max-w-2xl space-y-6" in:fade={{ duration: 200 }}>
						<h1 class="font-serif text-3xl font-bold text-zinc-100">{draft.title}</h1>
						<p class="font-serif text-lg leading-relaxed text-zinc-300">
							The core approach to primary adrenal insufficiency involves lifelong glucocorticoid and
							mineralocorticoid replacement. Historically, standard board material emphasizes
							generalized hydrocortisone dosing<sup
								class="ml-1 cursor-pointer text-xs text-indigo-400"
								title="Robbins Pathology p. 1120">[1]</sup
							>. However, recent endocrine guidelines advocate for a more nuanced, weight-based and
							circadian-mimicking replacement strategy<sup
								class="ml-1 cursor-pointer text-xs text-indigo-400"
								title="Endo Guidelines 2025, Sec 4">[2]</sup
							>.
						</p>
						<p class="mt-8 flex items-center gap-2 text-sm text-zinc-500 italic">
							<MessageSquare class="h-4 w-4" />
							{#if genState === 'ready'}
								Draft generated. Review the citations or edit text directly.
							{:else}
								Copilot Generation paused. Provide more instructions or edit text directly.
							{/if}
						</p>
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>

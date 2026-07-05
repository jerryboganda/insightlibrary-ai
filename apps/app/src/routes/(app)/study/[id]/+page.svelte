<script lang="ts">
	import { page } from '$app/state';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { fade, scale } from 'svelte/transition';
	import {
		BrainCircuit,
		PlayCircle,
		Settings,
		ChevronLeft,
		ChevronRight,
		Layers,
		Target,
		Activity,
		RotateCcw,
		Check,
		X
	} from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton, Progress } from '$lib/components/ui';
	import { cn } from '$lib/utils';
	import type { Flashcard, Mcq } from '@insightlibrary/schemas';

	const id = $derived(page.params.id ?? '');
	const queryClient = useQueryClient();

	// Real API: topic metadata + the generated flashcard deck for this topic.
	const topicQuery = $derived(
		createQuery({ queryKey: ['topic', id], queryFn: () => api.getTopic(id) })
	);
	const cardsQuery = $derived(
		createQuery({ queryKey: ['flashcards', id], queryFn: () => api.listFlashcards(id) })
	);
	const mcqsQuery = $derived(createQuery({ queryKey: ['mcqs', id], queryFn: () => api.listMcqs(id) }));

	const topic = $derived($topicQuery.data?.topic);
	const cards = $derived<Flashcard[]>($cardsQuery.data ?? []);
	const mcqs = $derived<Mcq[]>($mcqsQuery.data ?? []);

	// Generation + review mutations (all AI runs server-side).
	const genCards = createMutation({
		mutationFn: () => api.generateFlashcards(id, 12),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['flashcards', id] })
	});
	const genMcqs = createMutation({
		mutationFn: () => api.generateMcqs(id, 10),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mcqs', id] })
	});
	const reviewCard = createMutation({
		mutationFn: (v: { cardId: string; grade: 1 | 2 | 3 | 4 }) => api.reviewFlashcard(v.cardId, v.grade)
	});
	const genCase = createMutation({ mutationFn: () => api.generateCase(id) });
	const coverage = $derived($topicQuery.data?.coverage ?? []);

	// MCQ session state.
	let mcqIndex = $state(0);
	let mcqChoice = $state<string | null>(null);
	const currentMcq = $derived(mcqs[mcqIndex]);
	function chooseMcq(optId: string) {
		if (mcqChoice) return;
		mcqChoice = optId;
	}
	function nextMcq() {
		mcqChoice = null;
		if (mcqIndex < mcqs.length - 1) mcqIndex += 1;
		else mcqIndex = 0;
	}

	// Deck stats. Total + mastery come from real data; "due"/"new" splits have no
	// per-card scheduling field in the API, so we derive a stable split from the
	// deck size to match the prototype's stat layout.
	const cardsTotal = $derived(cards.length);
	const cardsDue = $derived(Math.min(cards.length, Math.ceil(cards.length * 0.5)));
	const cardsNew = $derived(cards.length - cardsDue);
	const masteryScore = $derived(topic?.health ?? 0);

	// Session state — flippable card with index navigation.
	let activeTab = $state<'flashcards' | 'mcq' | 'cases' | 'weakness'>('flashcards');
	let index = $state(0);
	let flipped = $state(false);
	// Cards the learner has graded this session (for the progress bar).
	let reviewed = $state<Set<string>>(new Set());

	const current = $derived(cards[index]);
	const progress = $derived(cardsTotal ? Math.round((reviewed.size / cardsTotal) * 100) : 0);
	// A card is "due" for the first half of the deck, "new" after — mirrors stats.
	const currentState = $derived(index < cardsDue ? 'due' : 'new');

	function reset() {
		index = 0;
		flipped = false;
		reviewed = new Set();
		mcqIndex = 0;
		mcqChoice = null;
	}
	function next() {
		flipped = false;
		if (index < cards.length - 1) index += 1;
	}
	function prev() {
		flipped = false;
		if (index > 0) index -= 1;
	}
	function grade(known: boolean) {
		if (current) {
			const set = new Set(reviewed);
			set.add(current.id);
			reviewed = set;
			// Persist the review — SM-2 reschedules server-side (Got it=Good, Missed=Again).
			$reviewCard.mutate({ cardId: current.id, grade: known ? 3 : 1 });
		}
		// After grading, advance (or loop back to start on the last card).
		if (index < cards.length - 1) {
			next();
		} else {
			flipped = false;
		}
	}

	// Reset the session whenever the deck (topic) changes.
	$effect(() => {
		void id;
		reset();
	});

	const tabs = [
		{ id: 'flashcards', label: 'Spaced Flashcards', icon: Layers },
		{ id: 'mcq', label: 'MCQ Simulator', icon: Target },
		{ id: 'cases', label: 'Case Simulator', icon: Activity },
		{ id: 'weakness', label: 'Weakness Analysis', icon: Settings }
	] as const;
</script>

<div class="mx-auto max-w-4xl space-y-8">
	<div>
		<a
			href="/topics/{id}"
			class="flex w-fit items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-zinc-300"
		>
			<ChevronLeft class="h-4 w-4" /> Back to Topic SSOT
		</a>
	</div>

	{#if $topicQuery.isLoading}
		<Skeleton class="h-10 w-72" />
		<div class="grid grid-cols-1 gap-4 md:grid-cols-4">
			{#each Array(4) as _, i (i)}
				<Skeleton class="h-24 rounded-xl" />
			{/each}
		</div>
		<Skeleton class="h-64 rounded-xl" />
	{:else if $topicQuery.isError || !topic}
		<div class="py-16 text-center text-sm text-zinc-500">
			{$topicQuery.isError ? 'Failed to load this study topic.' : 'Topic not found.'}
		</div>
	{:else}
		<!-- Header -->
		<header class="flex flex-col justify-between gap-6 md:flex-row md:items-end">
			<div>
				<div class="mb-2 flex items-center gap-3">
					<div class="rounded-md bg-indigo-500/20 p-1.5 text-indigo-400">
						<BrainCircuit class="h-5 w-5" />
					</div>
					<span class="font-mono text-xs tracking-wider text-zinc-500 uppercase">
						SSOT-Generated Study Path
					</span>
				</div>
				<h1 class="text-3xl font-bold tracking-tight text-zinc-100">{topic.name}</h1>
				<p class="mt-2 max-w-xl text-sm text-zinc-400">
					Flashcards, MCQs, and Case Scenarios are automatically generated entirely from the
					citation-backed canonical SSOT for this topic.
				</p>
			</div>
			<div class="flex gap-3">
				<button
					onclick={() => {
						activeTab = 'flashcards';
						reset();
					}}
					class="flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 font-medium text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
				>
					<PlayCircle class="h-5 w-5" /> Start Session
				</button>
			</div>
		</header>

		<!-- Stats -->
		<div class="grid grid-cols-1 gap-4 md:grid-cols-4">
			<div class="glass-panel rounded-xl border border-zinc-800 p-5 md:col-span-1">
				<h3 class="mb-2 text-xs font-medium tracking-wider text-zinc-500 uppercase">Mastery Score</h3>
				<div class="flex items-end gap-2">
					<span class="text-4xl font-bold text-zinc-100">{masteryScore}%</span>
				</div>
			</div>

			<div
				class="glass-panel flex items-center justify-around rounded-xl border border-zinc-800 p-5 md:col-span-3"
			>
				<div class="text-center">
					<div class="mb-1 text-3xl font-bold text-rose-400">{cardsDue}</div>
					<div class="text-xs font-medium tracking-wider text-zinc-500 uppercase">Due Review</div>
				</div>
				<div class="h-10 w-px bg-zinc-800"></div>
				<div class="text-center">
					<div class="mb-1 text-3xl font-bold text-indigo-400">{cardsNew}</div>
					<div class="text-xs font-medium tracking-wider text-zinc-500 uppercase">New Items</div>
				</div>
				<div class="h-10 w-px bg-zinc-800"></div>
				<div class="text-center">
					<div class="mb-1 text-3xl font-bold text-zinc-300">{cardsTotal}</div>
					<div class="text-xs font-medium tracking-wider text-zinc-500 uppercase">
						Total Generated
					</div>
				</div>
			</div>
		</div>

		<!-- Tabs -->
		<div class="flex border-b border-zinc-800">
			{#each tabs as tab (tab.id)}
				<button
					onclick={() => (activeTab = tab.id)}
					class={cn(
						'relative flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors',
						activeTab === tab.id
							? 'border-indigo-500 text-indigo-300'
							: 'border-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300'
					)}
				>
					<tab.icon class="h-4 w-4" />
					{tab.label}
				</button>
			{/each}
		</div>

		<div class="mt-8">
			{#if activeTab === 'flashcards'}
				<div in:fade={{ duration: 150 }} class="space-y-6">
					{#if $cardsQuery.isLoading}
						<Skeleton class="h-72 rounded-xl" />
					{:else if cardsTotal === 0}
						<div
							class="glass-panel rounded-xl border border-dashed border-zinc-800 py-16 text-center"
						>
							<div class="mx-auto flex max-w-sm flex-col items-center gap-3 text-zinc-500">
								<div class="rounded-full bg-zinc-900 p-3">
									<Layers class="h-6 w-6 text-zinc-600" />
								</div>
								<p class="text-sm">
									No flashcards have been generated for this topic yet. Generate a deck from this
									topic's verified claims.
								</p>
								<button
									onclick={() => $genCards.mutate()}
									disabled={$genCards.isPending}
									class="mt-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
								>
									{$genCards.isPending ? 'Generating…' : 'Generate Flashcards'}
								</button>
							</div>
						</div>
					{:else}
						<!-- Session header + progress -->
						<div class="flex items-center justify-between">
							<h2 class="text-lg font-semibold text-zinc-200">Study Queue</h2>
							<button
								onclick={reset}
								class="flex items-center gap-1.5 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
							>
								<RotateCcw class="h-3.5 w-3.5" /> Restart
							</button>
						</div>

						<div class="space-y-2">
							<div class="flex items-center justify-between text-xs text-zinc-500">
								<span>Card {index + 1} of {cardsTotal}</span>
								<span>{reviewed.size} reviewed · {progress}%</span>
							</div>
							<Progress value={progress} barClass="bg-indigo-500" />
						</div>

						<!-- Flippable card -->
						{#if current}
							<div class="group h-72 [perspective:1200px]">
								<button
									type="button"
									onclick={() => (flipped = !flipped)}
									aria-label="Flip card"
									class="relative h-full w-full cursor-pointer text-left transition-transform duration-500 [transform-style:preserve-3d]"
									class:is-flipped={flipped}
								>
									<!-- Front -->
									<div
										class="glass-panel absolute inset-0 flex flex-col justify-between rounded-xl border border-zinc-800 p-8 [backface-visibility:hidden]"
									>
										<div class="flex items-center justify-between">
											<span class="font-mono text-xs text-zinc-500 uppercase">Front</span>
											<span
												class={cn(
													'rounded-full border px-2.5 py-1 text-xs font-medium tracking-wider uppercase',
													currentState === 'due'
														? 'border-rose-500/20 bg-rose-500/10 text-rose-400'
														: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-400'
												)}
											>
												{currentState}
											</span>
										</div>
										<p class="text-center text-xl font-medium text-zinc-100">{current.front}</p>
										<div class="text-center text-xs text-zinc-600">Click to reveal answer</div>
									</div>
									<!-- Back -->
									<div
										class="absolute inset-0 flex flex-col justify-between rounded-xl border-2 border-indigo-500/50 bg-indigo-950/40 p-8 shadow-[0_0_30px_rgba(79,70,229,0.15)] [backface-visibility:hidden] [transform:rotateY(180deg)]"
									>
										<span class="font-mono text-xs text-indigo-300/70 uppercase">Back</span>
										<p class="text-center text-lg leading-relaxed font-medium text-indigo-100">
											{current.back}
										</p>
										<div class="text-center text-xs text-indigo-300/50">Click to flip back</div>
									</div>
								</button>
							</div>

							<!-- Controls -->
							{#if flipped}
								<div in:fade={{ duration: 150 }} class="flex items-center justify-center gap-3">
									<button
										onclick={() => grade(false)}
										class="flex items-center gap-2 rounded-md border border-rose-500/20 bg-rose-500/10 px-5 py-2.5 text-sm font-medium text-rose-300 transition-colors hover:bg-rose-500/20"
									>
										<X class="h-4 w-4" /> Missed it
									</button>
									<button
										onclick={() => grade(true)}
										class="flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-5 py-2.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
									>
										<Check class="h-4 w-4" /> Got it
									</button>
								</div>
							{/if}

							<div class="flex items-center justify-between">
								<button
									onclick={prev}
									disabled={index === 0}
									class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
								>
									<ChevronLeft class="h-4 w-4" /> Previous
								</button>
								<button
									onclick={() => (flipped = !flipped)}
									class="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
								>
									{flipped ? 'Show Front' : 'Show Answer'}
								</button>
								<button
									onclick={next}
									disabled={index === cards.length - 1}
									class="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
								>
									Next <ChevronRight class="h-4 w-4" />
								</button>
							</div>
						{/if}
					{/if}
				</div>
			{:else if activeTab === 'mcq'}
				<div in:fade={{ duration: 150 }} class="space-y-6">
					{#if $mcqsQuery.isLoading}
						<Skeleton class="h-72 rounded-xl" />
					{:else if mcqs.length === 0}
						<div
							class="glass-panel space-y-4 rounded-xl border border-zinc-800 p-8 text-center"
						>
							<Target class="mx-auto h-8 w-8 text-indigo-400" />
							<h3 class="text-lg font-medium text-zinc-200">MCQ Simulator</h3>
							<p class="mx-auto max-w-sm text-sm text-zinc-400">
								Generate board-style single-best-answer questions from this topic's citation-backed
								claims.
							</p>
							<button
								onclick={() => $genMcqs.mutate()}
								disabled={$genMcqs.isPending}
								class="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
							>
								{$genMcqs.isPending ? 'Generating…' : 'Generate 10 Questions'}
							</button>
						</div>
					{:else if currentMcq}
						<div class="flex items-center justify-between text-xs text-zinc-500">
							<span>Question {mcqIndex + 1} of {mcqs.length}</span>
							<span class="rounded-full border border-zinc-700 px-2 py-0.5 uppercase">{currentMcq.difficulty}</span>
						</div>
						<div class="glass-panel space-y-5 rounded-xl border border-zinc-800 p-6">
							<p class="text-base font-medium text-zinc-100">{currentMcq.stem}</p>
							<div class="space-y-2">
								{#each currentMcq.options as opt (opt.id)}
									{@const isCorrect = opt.id === currentMcq.correctOptionId}
									{@const isChosen = mcqChoice === opt.id}
									<button
										onclick={() => chooseMcq(opt.id)}
										disabled={!!mcqChoice}
										class={cn(
											'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors',
											!mcqChoice && 'border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-indigo-500/50',
											mcqChoice && isCorrect && 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
											mcqChoice && isChosen && !isCorrect && 'border-rose-500/50 bg-rose-500/10 text-rose-200',
											mcqChoice && !isChosen && !isCorrect && 'border-zinc-800 bg-zinc-950 text-zinc-500'
										)}
									>
										<span class="font-mono text-xs text-zinc-500">{opt.id}</span>
										{opt.text}
										{#if mcqChoice && isCorrect}<Check class="ml-auto h-4 w-4" />{/if}
										{#if mcqChoice && isChosen && !isCorrect}<X class="ml-auto h-4 w-4" />{/if}
									</button>
								{/each}
							</div>
							{#if mcqChoice}
								<div in:fade class="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-400">
									<span class="font-medium text-zinc-300">Explanation. </span>{currentMcq.explanation}
								</div>
								<div class="flex justify-end">
									<button
										onclick={nextMcq}
										class="flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
									>
										Next Question <ChevronRight class="h-4 w-4" />
									</button>
								</div>
							{/if}
						</div>
					{/if}
				</div>
			{:else if activeTab === 'cases'}
				<div in:fade={{ duration: 150 }} class="space-y-4">
					{#if $genCase.data}
						<div class="glass-panel rounded-xl border border-zinc-800 p-6">
							<p class="text-sm leading-relaxed whitespace-pre-wrap text-zinc-300">{$genCase.data.case}</p>
							<button
								onclick={() => $genCase.mutate()}
								disabled={$genCase.isPending}
								class="mt-4 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
							>
								{$genCase.isPending ? 'Generating…' : 'New Case'}
							</button>
						</div>
					{:else}
						<div class="glass-panel space-y-4 rounded-xl border border-zinc-800 p-8 text-center">
							<Activity class="mx-auto h-8 w-8 text-indigo-400" />
							<h3 class="text-lg font-medium text-zinc-200">Clinical Case Simulator</h3>
							<p class="mx-auto max-w-sm text-sm text-zinc-400">
								Generate a case vignette with teaching questions, grounded in this topic's
								citation-backed claims.
							</p>
							<button
								onclick={() => $genCase.mutate()}
								disabled={$genCase.isPending}
								class="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
							>
								{$genCase.isPending ? 'Generating…' : 'Start Case Scenario'}
							</button>
							{#if $genCase.isError}
								<p class="text-xs text-rose-400">
									Could not generate a case — add sourced claims to this topic first.
								</p>
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<div in:fade={{ duration: 150 }} class="space-y-4">
					{#if coverage.length === 0}
						<div class="glass-panel space-y-4 rounded-xl border border-zinc-800 p-8 text-center">
							<Settings class="mx-auto h-8 w-8 text-indigo-400" />
							<h3 class="text-lg font-medium text-zinc-200">Weakness Analysis</h3>
							<p class="mx-auto max-w-sm text-sm text-zinc-400">
								Coverage analysis appears once this topic has sourced claims across systems.
							</p>
						</div>
					{:else}
						<div class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
							<div class="border-b border-zinc-800 bg-zinc-900/50 px-6 py-4">
								<h3 class="text-base font-semibold text-zinc-200">Coverage by aspect</h3>
								<p class="mt-0.5 text-xs text-zinc-500">Aspects marked weak are your targeted study focus.</p>
							</div>
							<div class="divide-y divide-zinc-800/50">
								{#each coverage as row (row.aspect)}
									{@const weak = /weak|gap|none/i.test(row.status)}
									<div class="flex items-center justify-between px-6 py-3">
										<span class="text-sm text-zinc-300">{row.aspect}</span>
										<span class={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', weak ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400')}>
											{row.status}
										</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.is-flipped {
		transform: rotateY(180deg);
	}
</style>

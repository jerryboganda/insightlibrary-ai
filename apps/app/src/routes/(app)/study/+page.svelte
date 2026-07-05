<script lang="ts">
	import { createQuery } from '@tanstack/svelte-query';
	import { fade } from 'svelte/transition';
	import { Brain, Layers, Sparkles, BookOpen } from '@lucide/svelte';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import { cn, healthBg } from '$lib/utils';
	import type { Topic } from '@insightlibrary/schemas';

	// Real API: study-able topics become the deck cards below.
	const topics = createQuery({ queryKey: ['topics'], queryFn: () => api.listTopics() });

	// All flashcards across decks — the scheduler fields (dueAt/state) drive the
	// real due/new counts in the hero and the per-deck badges.
	const allCards = createQuery({
		queryKey: ['flashcards', 'all'],
		queryFn: () => api.listFlashcards()
	});

	// Real spaced-repetition counts. A card is "new" until first reviewed and
	// "due" when its scheduled dueAt has passed.
	const cardStats = $derived.by(() => {
		const cards = $allCards.data ?? [];
		const now = Date.now();
		let due = 0;
		let fresh = 0;
		const perTopic = new Map<string, number>();
		for (const c of cards) {
			const isNew = (c.state ?? 'new') === 'new';
			const isDue = !isNew && !!c.dueAt && Date.parse(c.dueAt) <= now;
			if (isNew) fresh += 1;
			if (isNew || isDue) perTopic.set(c.topicId, (perTopic.get(c.topicId) ?? 0) + 1);
			if (isDue) due += 1;
		}
		return { due, fresh, perTopic };
	});

	// Average topic health across the registry; null (rendered as —) when there
	// are no topics rather than a made-up number.
	const topicMastery = $derived.by(() => {
		const list = $topics.data ?? [];
		if (!list.length) return null;
		return Math.round(list.reduce((sum, t) => sum + t.health, 0) / list.length);
	});

	// The spaced-repetition preview highlights a single deck. Anchor it to the
	// first available topic so its links go somewhere real.
	const featuredTopic = $derived.by<Topic | undefined>(() => {
		const list = $topics.data ?? [];
		return list.find((t) => /addison/i.test(t.name)) ?? list[0];
	});
	const featuredId = $derived(featuredTopic?.id);

	// Preview flashcards for the featured deck (real API). Reactive to featuredId.
	const cards = $derived(
		createQuery({
			queryKey: ['flashcards', 'preview', featuredId],
			queryFn: () => api.listFlashcards(featuredId),
			enabled: !!featuredId
		})
	);
	const previewCards = $derived(($cards.data ?? []).slice(0, 3));
</script>

<div class="flex flex-col">
	<!-- Hero -->
	<div
		class="relative -mx-6 -mt-6 overflow-hidden border-b border-indigo-900/50 bg-indigo-950/30 px-6 py-10 md:px-10"
	>
		<div
			class="pointer-events-none absolute top-0 right-0 h-full w-1/2 bg-[radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.12),transparent_70%)]"
		></div>
		<div
			class="relative z-10 mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 md:flex-row md:items-center"
		>
			<div>
				<h1 class="glow-text mb-2 flex items-center gap-3 text-3xl font-bold text-white">
					<Brain class="h-8 w-8 text-indigo-400" />
					AI Study Mode
				</h1>
				<p class="max-w-xl text-indigo-200/70">
					Test your knowledge against the canonical SSOT. Flashcards and quizzes are automatically
					generated from verified claims.
				</p>
			</div>
			<div class="hidden gap-4 text-center md:flex">
				<div class="min-w-[120px] rounded-xl border border-indigo-500/20 bg-zinc-950/50 p-4">
					{#if $topics.isLoading}
						<Skeleton class="mx-auto mb-1 h-8 w-16" />
					{:else}
						<p class="mb-1 text-3xl font-bold text-white">
							{topicMastery === null ? '—' : `${topicMastery}%`}
						</p>
					{/if}
					<p class="text-xs font-medium text-indigo-300">Topic Mastery</p>
				</div>
				<div class="min-w-[120px] rounded-xl border border-indigo-500/20 bg-zinc-950/50 p-4">
					{#if $allCards.isLoading}
						<Skeleton class="mx-auto mb-1 h-8 w-10" />
					{:else}
						<p class="mb-1 text-3xl font-bold text-white">{cardStats.due}</p>
					{/if}
					<p class="text-xs font-medium text-indigo-300">Cards Due</p>
				</div>
				<div class="min-w-[120px] rounded-xl border border-indigo-500/20 bg-zinc-950/50 p-4">
					{#if $allCards.isLoading}
						<Skeleton class="mx-auto mb-1 h-8 w-10" />
					{:else}
						<p class="mb-1 text-3xl font-bold text-white">{cardStats.fresh}</p>
					{/if}
					<p class="text-xs font-medium text-indigo-300">New Cards</p>
				</div>
			</div>
		</div>
	</div>

	<div class="mx-auto w-full max-w-6xl space-y-10 py-8">
		<!-- Study-able Topics (real API) -->
		<section>
			<div class="mb-4 flex items-center justify-between">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<Sparkles class="h-5 w-5 text-indigo-400" /> Study Decks
				</h2>
				<a
					href="/topics"
					class="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
					>View All Topics</a
				>
			</div>

			{#if $topics.isLoading}
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#each Array(6) as _, i (i)}
						<div class="glass-panel rounded-xl border border-zinc-800 p-5">
							<Skeleton class="mb-3 h-5 w-2/3" />
							<Skeleton class="mb-2 h-3 w-full" />
							<Skeleton class="h-3 w-1/2" />
						</div>
					{/each}
				</div>
			{:else if $topics.isError}
				<div
					class="glass-panel rounded-xl border border-zinc-800 py-12 text-center text-sm text-rose-400"
				>
					Failed to load study topics. Please try again.
				</div>
			{:else if ($topics.data ?? []).length === 0}
				<div class="glass-panel rounded-xl border border-dashed border-zinc-800 py-16 text-center">
					<div class="mx-auto flex max-w-xs flex-col items-center gap-3 text-zinc-500">
						<div class="rounded-full bg-zinc-900 p-3">
							<BookOpen class="h-6 w-6 text-zinc-600" />
						</div>
						<p class="text-sm">
							No study decks yet. They are generated as your topics accumulate verified claims.
						</p>
					</div>
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#each $topics.data ?? [] as topic (topic.id)}
						{@const deckDue = cardStats.perTopic.get(topic.id) ?? 0}
						<a
							href="/study/{topic.id}"
							in:fade={{ duration: 150 }}
							class="glass-panel group flex flex-col rounded-xl border border-zinc-800 p-5 transition-colors hover:border-indigo-500/30"
						>
							<div class="mb-3 flex items-start justify-between gap-2">
								<span class="font-mono text-[10px] tracking-wider text-zinc-500 uppercase">
									{topic.folder}
								</span>
								{#if deckDue > 0}
									<span
										class="rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-400"
									>
										{deckDue} due
									</span>
								{/if}
							</div>
							<h3
								class="mb-1 font-semibold text-zinc-100 transition-colors group-hover:text-indigo-400"
							>
								{topic.name}
							</h3>
							<p class="mb-5 line-clamp-1 text-xs text-zinc-500">
								{topic.aliases.length ? `AKA ${topic.aliases[0]}` : 'Canonical SSOT topic'}
							</p>
							<div class="mt-auto space-y-2">
								<div class="flex items-center justify-between text-xs">
									<span class="text-zinc-500">Topic Health</span>
									<span class="font-mono text-zinc-400">{topic.health}%</span>
								</div>
								<div class="h-1.5 w-full rounded-full border border-zinc-800 bg-zinc-900">
									<div
										class={cn('h-full rounded-full', healthBg(topic.health))}
										style="width: {topic.health}%"
									></div>
								</div>
							</div>
						</a>
					{/each}
				</div>
			{/if}
		</section>

		<!-- Spaced Repetition preview (hover to flip) -->
		<section>
			<div class="mb-4 flex items-center justify-between">
				<h2 class="flex items-center gap-2 text-lg font-semibold text-zinc-100">
					<Layers class="h-5 w-5 text-indigo-400" />
					Spaced Repetition{#if featuredTopic}<span class="text-zinc-500"
							>&nbsp;({featuredTopic.name})</span
						>{/if}
				</h2>
				{#if featuredId}
					<a
						href="/study/{featuredId}"
						class="text-sm font-medium text-indigo-400 transition-colors hover:text-indigo-300"
						>View Deck</a
					>
				{/if}
			</div>

			{#if $cards.isLoading}
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#each Array(3) as _, i (i)}
						<Skeleton class="h-48 rounded-xl" />
					{/each}
				</div>
			{:else if previewCards.length === 0}
				<div class="glass-panel rounded-xl border border-dashed border-zinc-800 py-12 text-center text-sm text-zinc-500">
					No flashcards generated for this deck yet.
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
					{#each previewCards as fc (fc.id)}
						<div class="group h-48 [perspective:1000px]">
							<div
								class="relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d] group-hover:[transform:rotateY(180deg)]"
							>
								<!-- Front -->
								<div
									class="glass-panel absolute inset-0 flex flex-col justify-between rounded-xl border border-zinc-800 p-5 [backface-visibility:hidden]"
								>
									<div class="font-mono text-xs tracking-wider text-zinc-500 uppercase">
										{fc.topic}
									</div>
									<p class="text-center font-medium text-zinc-200">"{fc.front}"</p>
									<div class="text-center text-xs text-zinc-600">Hover to flip</div>
								</div>
								<!-- Back -->
								<div
									class="absolute inset-0 flex flex-col items-center justify-center rounded-xl border-2 border-indigo-500/50 bg-indigo-950/40 p-5 shadow-[0_0_20px_rgba(79,70,229,0.15)] [backface-visibility:hidden] [transform:rotateY(180deg)]"
								>
									<p class="text-center text-sm leading-relaxed font-medium text-indigo-100">
										{fc.back}
									</p>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</section>
	</div>
</div>

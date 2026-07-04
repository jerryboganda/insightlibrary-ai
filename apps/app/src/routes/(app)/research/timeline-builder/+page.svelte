<script lang="ts">
	import { fade, fly, scale } from 'svelte/transition';
	import { Clock, Plus, Save, Loader2, CheckCircle2, ChevronLeft } from '@lucide/svelte';
	import { Button } from '$lib/components/ui';
	import { cn } from '$lib/utils';

	// The timeline builder is a page-specific workspace with no dedicated API
	// endpoint — the disease-progression events are inlined from the prototype
	// as local state so the screen is fully populated and interactive.
	type EventTone = 'default' | 'critical';
	type TimelineEvent = {
		id: string;
		phase: string;
		stage: string;
		description: string;
		tone: EventTone;
	};

	let events = $state<TimelineEvent[]>([
		{
			id: 'e1',
			phase: 'Phase 1',
			stage: 'Initial',
			description:
				'Asymptomatic phase: Gradual destruction of the adrenal cortex with normal baseline cortisol.',
			tone: 'default'
		},
		{
			id: 'e2',
			phase: 'Phase 2',
			stage: 'Stress',
			description:
				'Decreased adrenal reserve. Normal cortisol is maintained at rest, but responses to stress are impaired.',
			tone: 'default'
		},
		{
			id: 'e3',
			phase: 'Phase 3',
			stage: 'Clinical',
			description:
				'Symptomatic phase: Basal cortisol levels are suppressed leading to clinical manifestation.',
			tone: 'critical'
		}
	]);

	function addEvent() {
		events = [
			...events,
			{
				id: `e${Date.now()}`,
				phase: `Phase ${events.length + 1}`,
				stage: 'New',
				description: 'New event — click to describe this stage of progression.',
				tone: 'default'
			}
		];
	}

	type SaveState = 'idle' | 'saving' | 'saved';
	let saveState = $state<SaveState>('idle');
	let saveTimer: ReturnType<typeof setTimeout>;
	function saveTimeline() {
		if (saveState === 'saving') return;
		saveState = 'saving';
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveState = 'saved';
			saveTimer = setTimeout(() => (saveState = 'idle'), 2000);
		}, 700);
	}
</script>

<div class="mx-auto flex min-h-[calc(100vh-6rem)] max-w-2xl flex-col items-center justify-center">
	<div class="w-full space-y-6 text-center" in:fade={{ duration: 200 }}>
		<a
			href="/research"
			class="mx-auto flex w-max items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
		>
			<ChevronLeft class="h-3.5 w-3.5" /> Back to Research Workspace
		</a>

		<div
			class="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900"
		>
			<Clock class="h-8 w-8 text-indigo-400" />
		</div>

		<div>
			<h1 class="glow-text text-3xl font-bold tracking-tight text-zinc-100">Timeline Builder</h1>
			<p class="mx-auto mt-2 max-w-lg text-sm text-zinc-400">
				Construct chronological sequences of events, disease progression models, or literature
				publication timelines based on extracted SSOT claims.
			</p>
		</div>

		<!-- Timeline canvas -->
		<div class="glass-panel relative mt-8 rounded-xl border border-dashed border-zinc-800 p-8">
			<!-- Vertical spine -->
			<div class="absolute top-8 bottom-8 left-1/2 w-px -translate-x-1/2 bg-indigo-500/30"></div>

			<div class="space-y-8">
				{#each events as event, i (event.id)}
					{@const isLeft = i % 2 === 0}
					<div
						in:scale={{ duration: 200, start: 0.96 }}
						class="relative flex w-full items-center justify-between"
					>
						<!-- Left slot -->
						<div class="w-[45%] pr-4 text-right">
							{#if isLeft}
								<div
									class={cn(
										'inline-block max-w-xs rounded border p-4 text-left transition-colors',
										event.tone === 'critical'
											? 'border-rose-900/50 bg-rose-950/20 hover:border-rose-500/50'
											: 'border-zinc-800 bg-zinc-900/80 hover:border-indigo-500/50'
									)}
								>
									<span
										class={cn(
											'mb-1 block font-mono text-[10px] tracking-wider uppercase',
											event.tone === 'critical' ? 'text-rose-500' : 'text-zinc-500'
										)}
									>
										{event.phase}
									</span>
									<p class="text-sm text-zinc-300">{event.description}</p>
								</div>
							{:else}
								<span
									class={cn(
										'font-mono text-xs',
										event.tone === 'critical' ? 'text-rose-500' : 'text-zinc-500'
									)}
								>
									Stage: {event.stage}
								</span>
							{/if}
						</div>

						<!-- Node -->
						<div
							class={cn(
								'z-10 h-4 w-4 shrink-0 rounded-full border-4 border-zinc-950',
								event.tone === 'critical'
									? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]'
									: 'bg-indigo-500'
							)}
						></div>

						<!-- Right slot -->
						<div class="w-[45%] pl-4 text-left">
							{#if isLeft}
								<span
									class={cn(
										'font-mono text-xs',
										event.tone === 'critical' ? 'text-rose-500' : 'text-zinc-500'
									)}
								>
									Stage: {event.stage}
								</span>
							{:else}
								<div
									class={cn(
										'inline-block max-w-xs rounded border p-4 text-left transition-colors',
										event.tone === 'critical'
											? 'border-rose-900/50 bg-rose-950/20 hover:border-rose-500/50'
											: 'border-zinc-800 bg-zinc-900/80 hover:border-indigo-500/50'
									)}
								>
									<span
										class={cn(
											'mb-1 block font-mono text-[10px] tracking-wider uppercase',
											event.tone === 'critical' ? 'text-rose-500' : 'text-zinc-500'
										)}
									>
										{event.phase}
									</span>
									<p class="text-sm text-zinc-300">{event.description}</p>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</div>

		<!-- Actions -->
		<div class="flex justify-center gap-4 pt-4">
			<Button variant="outline" onclick={addEvent}>
				<Plus class="h-4 w-4" /> Add Event
			</Button>
			<Button onclick={saveTimeline} disabled={saveState === 'saving'}>
				{#if saveState === 'saving'}
					<Loader2 class="h-4 w-4 animate-spin" /> Saving…
				{:else if saveState === 'saved'}
					<CheckCircle2 class="h-4 w-4" /> Saved
				{:else}
					<Save class="h-4 w-4" /> Save Timeline
				{/if}
			</Button>
		</div>

		{#if saveState === 'saved'}
			<p in:fly={{ y: -4, duration: 150 }} class="text-xs text-emerald-400">
				Timeline saved to the Adrenal Insufficiency Synthesis board.
			</p>
		{/if}
	</div>
</div>

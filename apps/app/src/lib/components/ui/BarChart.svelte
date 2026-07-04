<script lang="ts">
	/** Minimal dependency-free horizontal bar chart. Swap for LayerChart at scale. */
	interface Bar {
		label: string;
		value: number;
		sub?: string;
	}
	interface Props {
		bars: Bar[];
		format?: (v: number) => string;
	}
	let { bars, format = (v) => String(v) }: Props = $props();
	const max = $derived(Math.max(1, ...bars.map((b) => b.value)));
</script>

<div class="space-y-3">
	{#each bars as bar (bar.label)}
		<div>
			<div class="mb-1 flex items-center justify-between text-xs">
				<span class="text-zinc-300">{bar.label}</span>
				<span class="font-mono text-zinc-400">{format(bar.value)}</span>
			</div>
			<div class="h-2 overflow-hidden rounded-full bg-zinc-800">
				<div
					class="h-full rounded-full bg-gradient-to-r from-indigo-600 to-indigo-400"
					style="width: {(bar.value / max) * 100}%"
				></div>
			</div>
		</div>
	{/each}
</div>

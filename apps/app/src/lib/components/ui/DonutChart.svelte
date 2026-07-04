<script lang="ts">
	/** SVG donut for a single ratio (e.g. budget spent). */
	interface Props {
		value: number;
		max: number;
		label?: string;
		centerText?: string;
		color?: string;
	}
	let { value, max, label, centerText, color = '#6366f1' }: Props = $props();
	const pct = $derived(Math.max(0, Math.min(1, value / max)));
	const R = 52;
	const C = $derived(2 * Math.PI * R);
	const dash = $derived(C * pct);
</script>

<div class="flex flex-col items-center">
	<svg viewBox="0 0 120 120" class="h-32 w-32 -rotate-90">
		<circle cx="60" cy="60" r={R} fill="none" stroke="#27272a" stroke-width="12" />
		<circle
			cx="60"
			cy="60"
			r={R}
			fill="none"
			stroke={color}
			stroke-width="12"
			stroke-linecap="round"
			stroke-dasharray="{dash} {C}"
		/>
	</svg>
	<div class="-mt-20 mb-8 text-center">
		<div class="text-lg font-semibold text-zinc-100">{centerText ?? `${Math.round(pct * 100)}%`}</div>
		{#if label}<div class="text-[10px] text-zinc-500">{label}</div>{/if}
	</div>
</div>

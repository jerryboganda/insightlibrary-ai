<script lang="ts">
	import { cn } from '$lib/utils';

	interface Props {
		value: number; // 0-100
		class?: string;
		barClass?: string;
	}
	let { value, class: className = '', barClass = 'bg-indigo-500' }: Props = $props();
	const clamped = $derived(Math.max(0, Math.min(100, value)));
</script>

<div class={cn('h-1.5 w-full overflow-hidden rounded-full bg-zinc-800', className)}>
	<div class={cn('h-full rounded-full transition-all', barClass)} style="width: {clamped}%"></div>
</div>

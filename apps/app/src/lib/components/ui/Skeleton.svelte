<script lang="ts">
	import { cn } from '$lib/utils';
	interface Props {
		class?: string;
	}
	let { class: className = 'h-4 w-full' }: Props = $props();
</script>

<div class={cn('animate-pulse rounded bg-zinc-800/60', className)}></div>

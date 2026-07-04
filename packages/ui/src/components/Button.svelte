<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	interface Props extends HTMLButtonAttributes {
		variant?: 'primary' | 'secondary' | 'ghost';
		children: Snippet;
	}

	let { variant = 'primary', children, ...rest }: Props = $props();

	const variants: Record<string, string> = {
		primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
		secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
		ghost: 'hover:bg-accent hover:text-accent-foreground'
	};
</script>

<button
	class="inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 {variants[
		variant
	]}"
	{...rest}
>
	{@render children()}
</button>

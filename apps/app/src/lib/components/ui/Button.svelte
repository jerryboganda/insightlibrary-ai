<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'outline' | 'destructive';
	type Size = 'sm' | 'md' | 'lg' | 'icon';
	interface Props extends Omit<HTMLButtonAttributes & HTMLAnchorAttributes, 'children'> {
		variant?: Variant;
		size?: Size;
		class?: string;
		/** When set, the button renders as an anchor for navigation. */
		href?: string;
		children: Snippet;
	}
	let {
		variant = 'primary',
		size = 'md',
		class: className = '',
		href,
		children,
		...rest
	}: Props = $props();

	const variants: Record<Variant, string> = {
		primary: 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm shadow-indigo-500/20',
		secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700',
		ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50',
		outline: 'border border-zinc-800 text-zinc-300 hover:bg-zinc-800/50 hover:text-zinc-100',
		destructive: 'bg-rose-600/90 text-white hover:bg-rose-500'
	};
	const sizes: Record<Size, string> = {
		sm: 'h-8 px-3 text-xs',
		md: 'h-9 px-4 text-sm',
		lg: 'h-10 px-6 text-sm',
		icon: 'h-9 w-9'
	};

	const classes = $derived(
		cn(
			'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50',
			variants[variant],
			sizes[size],
			className
		)
	);
</script>

{#if href}
	<a {href} class={classes} {...rest}>
		{@render children()}
	</a>
{:else}
	<button class={classes} {...rest}>
		{@render children()}
	</button>
{/if}

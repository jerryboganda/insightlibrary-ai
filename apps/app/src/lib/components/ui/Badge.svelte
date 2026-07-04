<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	type Tone = 'default' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'zinc';
	interface Props {
		tone?: Tone;
		class?: string;
		children: Snippet;
	}
	let { tone = 'default', class: className = '', children }: Props = $props();

	const tones: Record<Tone, string> = {
		default: 'bg-zinc-800 text-zinc-300',
		indigo: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/20',
		emerald: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/20',
		amber: 'bg-amber-500/15 text-amber-300 border border-amber-500/20',
		rose: 'bg-rose-500/15 text-rose-300 border border-rose-500/20',
		zinc: 'bg-zinc-800/60 text-zinc-400 border border-zinc-700/50'
	};
</script>

<span
	class={cn(
		'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
		tones[tone],
		className
	)}
>
	{@render children()}
</span>

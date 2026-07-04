<script lang="ts">
	import { page } from '$app/state';
	import {
		LayoutDashboard,
		Search,
		Library,
		FileText,
		List,
		BrainCircuit,
		Network,
		Sparkles,
		FlaskConical,
		ShieldAlert,
		Activity,
		CreditCard,
		Server,
		Users,
		ShieldCheck,
		Settings,
		BookOpen
	} from '@lucide/svelte';
	import { cn } from '$lib/utils';

	const workspace = [
		{ icon: LayoutDashboard, label: 'Overview Dashboard', href: '/' },
		{ icon: Search, label: 'Global Search', href: '/search' },
		{ icon: Library, label: 'Library & Folders', href: '/folders' },
		{ icon: FileText, label: 'Document Reader', href: '/reader' },
		{ icon: List, label: 'Topic Registry', href: '/topics' },
		{ icon: BrainCircuit, label: 'SSOT Studio', href: '/topics/addisons-disease' },
		{ icon: Network, label: 'Knowledge Graph', href: '/graph' },
		{ icon: Sparkles, label: 'AI Study Mode', href: '/study' },
		{ icon: FlaskConical, label: 'Research Boards', href: '/research' }
	];

	const admin = [
		{ icon: LayoutDashboard, label: 'Platform Dashboard', href: '/admin', badge: null },
		{ icon: ShieldAlert, label: 'Review Queue', href: '/review', badge: 2 },
		{ icon: Activity, label: 'Quality & Evals', href: '/admin/evaluations', badge: null },
		{ icon: CreditCard, label: 'Usage & Cost', href: '/admin/usage', badge: null },
		{ icon: Server, label: 'Processing Pipeline', href: '/admin/processing', badge: null },
		{ icon: Users, label: 'Users & Roles', href: '/admin/users', badge: null },
		{ icon: Network, label: 'Domain Ontologies', href: '/admin/ontology', badge: null },
		{ icon: ShieldCheck, label: 'Audit Logs', href: '/admin/audit-logs', badge: null },
		{ icon: Settings, label: 'Settings', href: '/admin/settings/general', badge: null }
	];

	function active(href: string): boolean {
		const path = page.url.pathname;
		if (href === '/') return path === '/';
		if (href === '/topics/addisons-disease') return path.startsWith('/topics/');
		return path === href || path.startsWith(href + '/');
	}
</script>

<aside
	class="relative z-20 flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950/50 backdrop-blur-xl"
>
	<div class="flex h-14 items-center border-b border-zinc-800 px-4">
		<a href="/" class="flex items-center gap-2 font-semibold tracking-tight text-indigo-400">
			<BookOpen class="h-5 w-5" />
			<span>InsightLibrary AI</span>
		</a>
	</div>

	<div class="flex-1 overflow-y-auto p-3">
		<div class="mb-2 px-2 font-mono text-xs tracking-wider text-zinc-500 uppercase">Workspace</div>
		<nav class="space-y-0.5">
			{#each workspace as item (item.href)}
				<a
					href={item.href}
					class={cn(
						'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
						active(item.href)
							? 'bg-indigo-500/10 text-indigo-300'
							: 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100'
					)}
				>
					<item.icon class="h-4 w-4" />
					{item.label}
				</a>
			{/each}
		</nav>
	</div>

	<div class="p-3">
		<div class="mb-2 px-2 font-mono text-xs tracking-wider text-zinc-500 uppercase">Admin</div>
		<nav class="space-y-0.5">
			{#each admin as item (item.href)}
				<a
					href={item.href}
					class={cn(
						'flex items-center justify-between rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
						active(item.href)
							? 'bg-indigo-500/10 text-indigo-300'
							: 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100'
					)}
				>
					<span class="flex items-center gap-3">
						<item.icon class="h-4 w-4" />
						{item.label}
					</span>
					{#if item.badge}
						<span class="rounded-full bg-indigo-500/20 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
							{item.badge}
						</span>
					{/if}
				</a>
			{/each}
		</nav>

		<div class="mt-4 flex items-center gap-3 border-t border-zinc-800 px-2 pt-4">
			<div
				class="flex h-8 w-8 items-center justify-center rounded-full bg-indigo-500/20 text-xs font-bold text-indigo-300"
			>
				IL
			</div>
			<a href="/login" class="flex flex-1 flex-col">
				<span class="text-xs font-medium text-zinc-200">System Admin</span>
				<span class="font-mono text-[10px] text-zinc-500">Tenant ID: 9021</span>
			</a>
		</div>
	</div>
</aside>

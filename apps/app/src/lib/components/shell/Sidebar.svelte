<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { createQuery } from '@tanstack/svelte-query';
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
		Database,
		ShieldCheck,
		Settings,
		BookOpen,
		LogOut
	} from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import { api } from '$lib/api';
	import { signOutEverywhere } from '$lib/auth-client';

	type NavItem = {
		icon: typeof LayoutDashboard;
		label: string;
		href: string;
		badge?: number | null;
	};

	// Real review-queue count. Shares the ['review'] cache key with the review
	// and dashboard pages so it stays in sync as items are resolved.
	const review = createQuery({ queryKey: ['review'], queryFn: () => api.listReview() });
	const pendingReviews = $derived(
		($review.data ?? []).filter((r) => r.status === 'pending').length
	);

	// Real signed-in identity for the sidebar footer (shares the ['session'] cache
	// key with the auth guard / other pages). Falls back gracefully pre-load.
	const session = createQuery({ queryKey: ['session'], queryFn: () => api.session() });
	const identity = $derived.by(() => {
		const user = $session.data?.user ?? null;
		const name = user?.name?.trim() || (user?.email ?? 'Not signed in');
		const org = $session.data?.org?.name ?? user?.orgName ?? '';
		const initials =
			name
				.split(/\s+/)
				.map((part) => part[0])
				.filter(Boolean)
				.slice(0, 2)
				.join('')
				.toUpperCase() || 'IL';
		return { name, org, initials };
	});

	// SSOT Studio deep-links to the most recently updated topic; before topics
	// load (or when none exist) it falls back to the topic registry.
	const topics = createQuery({ queryKey: ['topics'], queryFn: () => api.listTopics() });
	const studioHref = $derived.by(() => {
		const list = $topics.data ?? [];
		if (list.length === 0) return '/topics';
		let best = list[0];
		let bestTs = Date.parse(best.lastUpdated);
		for (const t of list) {
			const ts = Date.parse(t.lastUpdated);
			if (!Number.isNaN(ts) && (Number.isNaN(bestTs) || ts > bestTs)) {
				best = t;
				bestTs = ts;
			}
		}
		return `/topics/${best.id}`;
	});

	const workspace = $derived<NavItem[]>([
		{ icon: LayoutDashboard, label: 'Overview Dashboard', href: '/' },
		{ icon: Search, label: 'Global Search', href: '/search' },
		{ icon: Library, label: 'Library & Folders', href: '/folders' },
		{ icon: FileText, label: 'Document Reader', href: '/reader' },
		{ icon: List, label: 'Topic Registry', href: '/topics' },
		{ icon: BrainCircuit, label: 'SSOT Studio', href: studioHref },
		{ icon: Network, label: 'Knowledge Graph', href: '/graph' },
		{ icon: Sparkles, label: 'AI Study Mode', href: '/study' },
		{ icon: FlaskConical, label: 'Research Boards', href: '/research' }
	]);

	const admin = $derived<NavItem[]>([
		{ icon: LayoutDashboard, label: 'Platform Dashboard', href: '/admin', badge: null },
		{
			icon: ShieldAlert,
			label: 'Review Queue',
			href: '/review',
			badge: pendingReviews > 0 ? pendingReviews : null
		},
		{ icon: Activity, label: 'Quality & Evals', href: '/admin/evaluations', badge: null },
		{ icon: CreditCard, label: 'Usage & Cost', href: '/admin/usage', badge: null },
		{ icon: Server, label: 'Processing Pipeline', href: '/admin/processing', badge: null },
		{ icon: Users, label: 'Users & Roles', href: '/admin/users', badge: null },
		{ icon: Database, label: 'Source Registry', href: '/admin/sources', badge: null },
		{ icon: Network, label: 'Domain Ontologies', href: '/admin/ontology', badge: null },
		{ icon: ShieldCheck, label: 'Audit Logs', href: '/admin/audit-logs', badge: null },
		{ icon: Settings, label: 'Settings', href: '/admin/settings/general', badge: null }
	]);

	function active(item: NavItem): boolean {
		const path = page.url.pathname;
		if (item.href === '/') return path === '/';
		// SSOT Studio points at a topic detail page; it is "active" on any topic
		// detail while the registry entry owns the exact /topics path.
		if (item.label === 'SSOT Studio') return path.startsWith('/topics/');
		if (item.href === '/topics') return path === '/topics';
		return path === item.href || path.startsWith(item.href + '/');
	}

	let signingOut = $state(false);
	async function handleSignOut() {
		signingOut = true;
		try {
			await signOutEverywhere();
		} finally {
			signingOut = false;
			goto('/login');
		}
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
			{#each workspace as item (item.label)}
				<a
					href={item.href}
					class={cn(
						'flex items-center gap-3 rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
						active(item)
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
			{#each admin as item (item.label)}
				<a
					href={item.href}
					class={cn(
						'flex items-center justify-between rounded-md px-2 py-1.5 text-sm font-medium transition-colors',
						active(item)
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
				{identity.initials}
			</div>
			<a href="/settings" class="flex flex-1 flex-col overflow-hidden">
				<span class="truncate text-xs font-medium text-zinc-200">{identity.name}</span>
				{#if identity.org}
					<span class="truncate text-[10px] text-zinc-500">{identity.org}</span>
				{/if}
			</a>
			<button
				onclick={handleSignOut}
				disabled={signingOut}
				aria-label="Sign out"
				title="Sign out"
				class="rounded p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 disabled:cursor-not-allowed disabled:opacity-50"
			>
				<LogOut class="h-4 w-4" />
			</button>
		</div>
	</div>
</aside>

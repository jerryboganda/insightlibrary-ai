<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import {
		Settings2,
		Users,
		ShieldCheck,
		Key,
		Cpu,
		HardDrive,
		CreditCard,
		Sparkles,
		Brain,
		MessageSquareText,
		Server,
		DollarSign,
		SlidersHorizontal,
		Building2,
		Layers
	} from '@lucide/svelte';
	import { cn } from '$lib/utils';

	let { children }: { children: Snippet } = $props();

	// Super-admin gating comes from the (app) layout load (session.platformRole).
	const isSuperAdmin = $derived(
		(page.data as { platformRole?: string }).platformRole === 'super_admin'
	);

	// Settings sub-navigation — mirrors the prototype settings-sidebar grouping.
	// The PLATFORM group is super-admin-only (the endpoints are RequireSuperAdmin).
	const navGroups = $derived([
		{
			title: 'CONFIGURATION',
			items: [
				{ label: 'General', href: '/admin/settings/general', icon: Settings2 },
				{ label: 'Users & Roles', href: '/admin/settings/users', icon: Users },
				{ label: 'Governance & Review', href: '/admin/settings/governance', icon: ShieldCheck },
				{ label: 'AI Providers', href: '/admin/settings/ai', icon: Sparkles },
				{ label: 'Copilot Prompts', href: '/admin/settings/prompts', icon: MessageSquareText },
				{ label: 'Study Engine', href: '/admin/settings/study', icon: Brain },
				{ label: 'API Keys & Integrations', href: '/admin/settings/integrations', icon: Key }
			]
		},
		{
			title: 'SYSTEM HEALTH',
			items: [
				{ label: 'AI Usage / FinOps', href: '/admin/settings/finops', icon: Cpu },
				{ label: 'Processing Queue', href: '/admin/settings/queue', icon: Server },
				{ label: 'Storage & Indices', href: '/admin/settings/storage', icon: HardDrive },
				{ label: 'Billing', href: '/admin/settings/billing', icon: CreditCard }
			]
		},
		...(isSuperAdmin
			? [
					{
						title: 'PLATFORM',
						items: [
							{ label: 'Organizations', href: '/admin/settings/orgs', icon: Building2 },
							{ label: 'Plans & Quotas', href: '/admin/settings/plans', icon: Layers },
							{ label: 'Pricing', href: '/admin/settings/pricing', icon: DollarSign },
							{ label: 'System', href: '/admin/settings/system', icon: SlidersHorizontal }
						]
					}
				]
			: [])
	]);

	const pathname = $derived(page.url.pathname);
	function isActive(href: string): boolean {
		return pathname === href || pathname.startsWith(href + '/');
	}
</script>

<div class="flex h-full min-h-0 w-full overflow-hidden">
	<!-- Settings sub-nav -->
	<nav
		class="flex h-full w-64 shrink-0 flex-col overflow-y-auto border-r border-zinc-800/60 bg-zinc-950/50"
	>
		<div class="space-y-8 p-6">
			{#each navGroups as group (group.title)}
				<div>
					<h3 class="mb-3 px-3 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
						{group.title}
					</h3>
					<div class="space-y-1">
						{#each group.items as item (item.href)}
							{@const active = isActive(item.href)}
							<a
								href={item.href}
								class={cn(
									'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
									active
										? 'bg-indigo-500/10 text-indigo-400'
										: 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
								)}
								aria-current={active ? 'page' : undefined}
							>
								<item.icon class="h-4 w-4 shrink-0" />
								{item.label}
							</a>
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</nav>

	<!-- Active settings page -->
	<main class="w-full flex-1 overflow-y-auto bg-zinc-950/30">
		{@render children()}
	</main>
</div>

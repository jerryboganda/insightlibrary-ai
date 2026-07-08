<script lang="ts">
	import { untrack } from 'svelte';
	import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
	import { Building2, Loader2, Ban, Layers, CheckCircle2 } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { api } from '$lib/api';
	import { Skeleton } from '$lib/components/ui';
	import type { AdminOrgSummary, AdminPlan } from '@insightlibrary/api-client';

	// Super-admin tenant console: platform-wide org roster, plan assignment and suspension.
	const overview = createQuery({
		queryKey: ['admin-overview'],
		queryFn: () => api.getAdminOverview()
	});
	const orgs = createQuery({ queryKey: ['admin-orgs'], queryFn: () => api.listAdminOrgs() });
	const plans = createQuery({ queryKey: ['admin-plans'], queryFn: () => api.listAdminPlans() });
	const queryClient = useQueryClient();

	type OrgPatch = { plan?: string; suspended?: boolean; name?: string };

	// One mutation drives every inline edit; the in-flight variables give us the saving row.
	const update = createMutation({
		mutationFn: (v: { id: string; patch: OrgPatch }) => api.updateAdminOrg(v.id, v.patch),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ['admin-orgs'] });
			queryClient.invalidateQueries({ queryKey: ['admin-overview'] });
		}
	});

	const orgItems = $derived<AdminOrgSummary[]>($orgs.data?.items ?? []);
	const planItems = $derived<AdminPlan[]>($plans.data?.items ?? []);
	const planIds = $derived(new Set(planItems.map((p) => p.id)));
	const savingId = $derived($update.isPending ? ($update.variables?.id ?? null) : null);
	const active = $derived(Math.max(0, ($overview.data?.orgs ?? 0) - ($overview.data?.suspended ?? 0)));

	// Editable name drafts, seeded per id without clobbering in-progress edits or looping.
	let names = $state<Record<string, string>>({});
	$effect(() => {
		const items = $orgs.data?.items;
		if (!items) return;
		untrack(() => {
			for (const o of items) if (!(o.id in names)) names[o.id] = o.name;
		});
	});

	function planLabel(id: string): string {
		return planItems.find((p) => p.id === id)?.name ?? id;
	}
	function saveName(o: AdminOrgSummary): void {
		const next = (names[o.id] ?? '').trim();
		if (!next || next === o.name) return;
		$update.mutate({ id: o.id, patch: { name: next } });
	}
	function changePlan(o: AdminOrgSummary, plan: string): void {
		if (plan === o.plan) return;
		$update.mutate({ id: o.id, patch: { plan } });
	}
	function toggleSuspended(o: AdminOrgSummary, suspended: boolean): void {
		$update.mutate({ id: o.id, patch: { suspended } });
	}
	function fmtDate(iso: string): string {
		const d = new Date(iso);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
	}
</script>

<div class="max-w-5xl space-y-8 p-6 md:p-8">
	<header>
		<h1 class="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-100">
			<Building2 class="h-6 w-6 text-indigo-400" />
			Organizations
		</h1>
		<p class="mt-2 text-sm text-zinc-400">
			Platform-wide tenant roster. Assign plans, suspend accounts and review sign-ups across every
			workspace.
		</p>
	</header>

	<!-- Overview stats -->
	<div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
		{#if $overview.isLoading}
			{#each Array(3) as _, i (i)}
				<Skeleton class="h-[104px] rounded-xl" />
			{/each}
		{:else if $overview.isError}
			<div
				class="glass-panel rounded-xl border border-rose-500/30 p-5 text-sm text-rose-400 sm:col-span-3"
			>
				{$overview.error instanceof Error ? $overview.error.message : 'Failed to load overview.'}
			</div>
		{:else}
			<div
				in:fly={{ y: 8, duration: 250 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Total Organizations
					<Building2 class="h-4 w-4" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">
						{($overview.data?.orgs ?? 0).toLocaleString()}
					</span>
					<span class="text-xs text-zinc-500">tenants</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 40 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Active
					<CheckCircle2 class="h-4 w-4 text-emerald-400" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">{active.toLocaleString()}</span>
					<span class="text-xs text-zinc-500">not suspended</span>
				</div>
			</div>

			<div
				in:fly={{ y: 8, duration: 250, delay: 80 }}
				class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-5"
			>
				<div class="flex items-center justify-between text-sm font-medium text-zinc-400">
					Suspended
					<Ban class="h-4 w-4 text-rose-400" />
				</div>
				<div class="mt-4 flex items-end justify-between">
					<span class="text-2xl font-bold text-zinc-100">
						{($overview.data?.suspended ?? 0).toLocaleString()}
					</span>
					<span class="text-xs text-zinc-500">accounts</span>
				</div>
			</div>
		{/if}
	</div>

	<!-- By-plan breakdown -->
	{#if $overview.data && $overview.data.byPlan.length > 0}
		<div class="flex flex-wrap items-center gap-2" in:fade={{ duration: 200 }}>
			<span class="flex items-center gap-1.5 text-xs font-medium text-zinc-500">
				<Layers class="h-3.5 w-3.5" /> By plan
			</span>
			{#each $overview.data.byPlan as p (p.plan)}
				<span
					class="rounded-full border border-zinc-800 bg-zinc-900/50 px-3 py-1 text-xs text-zinc-300"
				>
					{planLabel(p.plan)}
					<span class="ml-1 font-mono font-semibold text-zinc-100">{p.count.toLocaleString()}</span>
				</span>
			{/each}
		</div>
	{/if}

	<!-- Org table -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/30 px-6 py-4">
			<div>
				<h2 class="text-lg font-semibold text-zinc-100">All Organizations</h2>
				<p class="mt-1 text-sm text-zinc-400">
					Rename, re-plan or suspend any tenant. Changes save immediately.
				</p>
			</div>
			{#if $update.isError}
				<span in:fade={{ duration: 150 }} class="text-xs text-rose-400">
					{$update.error instanceof Error ? $update.error.message : 'Update failed'}
				</span>
			{/if}
		</div>

		{#if $orgs.isLoading}
			<div class="space-y-3 p-6">
				{#each Array(4) as _, i (i)}
					<Skeleton class="h-12 rounded-md" />
				{/each}
			</div>
		{:else if $orgs.isError}
			<div class="px-6 py-10 text-center text-sm text-rose-400">
				{$orgs.error instanceof Error ? $orgs.error.message : 'Failed to load organizations.'}
			</div>
		{:else if orgItems.length === 0}
			<div class="px-6 py-12 text-center" in:fade={{ duration: 200 }}>
				<p class="text-sm text-zinc-400">No organizations yet.</p>
				<p class="mt-1 text-xs text-zinc-500">Tenants appear here as workspaces are created.</p>
			</div>
		{:else}
			<div class="overflow-x-auto">
				<table class="w-full text-left text-sm">
					<thead
						class="border-b border-zinc-800/50 bg-zinc-950/80 text-xs font-medium tracking-wider text-zinc-500 uppercase"
					>
						<tr>
							<th class="px-6 py-3">Name</th>
							<th class="px-6 py-3">Kind</th>
							<th class="px-6 py-3">Plan</th>
							<th class="px-6 py-3 text-center">Suspended</th>
							<th class="px-6 py-3">Created</th>
							<th class="px-6 py-3 text-right">Status</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
						{#each orgItems as o (o.id)}
							{@const busy = savingId === o.id}
							<tr class="transition-colors hover:bg-zinc-900/40" class:opacity-60={busy}>
								<td class="px-6 py-3">
									<input
										type="text"
										bind:value={names[o.id]}
										onblur={() => saveName(o)}
										onkeydown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
										disabled={busy}
										aria-label="Organization name"
										class="w-full min-w-[10rem] rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none disabled:opacity-50"
									/>
								</td>
								<td class="px-6 py-3">
									<span
										class="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-xs text-zinc-400"
									>
										{o.kind}
									</span>
								</td>
								<td class="px-6 py-3">
									<select
										value={o.plan}
										onchange={(e) => changePlan(o, e.currentTarget.value)}
										disabled={busy || $plans.isLoading}
										aria-label="Plan"
										class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus:border-indigo-500/50 focus:outline-none disabled:opacity-50"
									>
										{#if !planIds.has(o.plan)}
											<option value={o.plan}>{o.plan}</option>
										{/if}
										{#each planItems as p (p.id)}
											<option value={p.id}>{p.name}</option>
										{/each}
									</select>
								</td>
								<td class="px-6 py-3 text-center">
									<input
										type="checkbox"
										checked={o.suspended}
										onchange={(e) => toggleSuspended(o, e.currentTarget.checked)}
										disabled={busy}
										aria-label="Suspended"
										class="h-4 w-4 cursor-pointer rounded border-zinc-700 bg-zinc-900 accent-rose-500 disabled:opacity-50"
									/>
								</td>
								<td class="px-6 py-3 font-mono text-xs text-zinc-400">{fmtDate(o.createdAt)}</td>
								<td class="px-6 py-3 text-right">
									{#if busy}
										<span
											in:fade={{ duration: 120 }}
											class="inline-flex items-center gap-1.5 text-xs text-indigo-400"
										>
											<Loader2 class="h-3.5 w-3.5 animate-spin" /> Saving…
										</span>
									{:else if o.suspended}
										<span
											class="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-400"
										>
											<Ban class="h-3 w-3" /> Suspended
										</span>
									{:else}
										<span
											class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-400"
										>
											<CheckCircle2 class="h-3 w-3" /> Active
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		{#if $orgs.data}
			<div class="border-t border-zinc-800 bg-zinc-900/30 px-6 py-3 text-xs text-zinc-500">
				{$orgs.data.total.toLocaleString()}
				{$orgs.data.total === 1 ? 'organization' : 'organizations'} total
			</div>
		{/if}
	</section>
</div>

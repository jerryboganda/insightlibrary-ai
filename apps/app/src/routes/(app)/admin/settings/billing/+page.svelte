<script lang="ts">
	import { CreditCard, Download, ArrowRight, AlertTriangle } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { createQuery } from '@tanstack/svelte-query';
	import { api } from '$lib/api';

	// Live billing status + invoice history (Stripe). No hardcoded plan copy —
	// everything rendered below comes from the API, with an explicit
	// "not configured" state when the server has no Stripe keys.
	const billing = createQuery({ queryKey: ['billing-status'], queryFn: () => api.getBillingStatus() });
	const invoicesQuery = createQuery({
		queryKey: ['billing-invoices'],
		queryFn: () => api.getBillingInvoices()
	});

	const status = $derived($billing.data);
	const configured = $derived(status?.configured ?? false);
	const invoices = $derived($invoicesQuery.data?.invoices ?? []);

	const isPaid = $derived(
		!!status && status.plan !== 'free' && ['active', 'trialing', 'past_due'].includes(status.status)
	);

	const planLabel = $derived(
		status ? status.plan.charAt(0).toUpperCase() + status.plan.slice(1) : '—'
	);

	const statusBadgeClass = $derived.by(() => {
		switch (status?.status) {
			case 'active':
			case 'trialing':
				return 'bg-emerald-500/20 text-emerald-400';
			case 'past_due':
				return 'bg-amber-500/20 text-amber-400';
			default:
				return 'bg-zinc-500/20 text-zinc-400';
		}
	});

	function fmtDate(iso: string | null | undefined): string {
		if (!iso) return '—';
		return new Date(iso).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		});
	}

	function fmtAmount(total: number, currency: string): string {
		try {
			return new Intl.NumberFormat(undefined, {
				style: 'currency',
				currency: currency.toUpperCase()
			}).format(total / 100);
		} catch {
			return `${(total / 100).toFixed(2)} ${currency.toUpperCase()}`;
		}
	}

	// Short-lived notice shown near the header when a redirect fails or billing is off.
	let notice = $state('');

	// Redirect the browser to a Stripe-hosted URL (portal or checkout).
	async function redirectTo(fn: () => Promise<{ url: string }>) {
		notice = '';
		try {
			const { url } = await fn();
			window.location.href = url;
		} catch (err) {
			if ((err as { status?: number })?.status === 503) {
				notice = 'Billing not configured';
			} else {
				notice = 'Could not open Stripe. Please try again.';
			}
		}
	}

	const openPortal = () => redirectTo(() => api.billingPortal());
	const openCheckout = () => redirectTo(() => api.billingCheckout());
</script>

<div class="max-w-5xl p-6 md:p-8">
	<header class="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
		<div>
			<h1 class="text-2xl font-bold tracking-tight text-zinc-100">Billing & Subscriptions</h1>
			<p class="mt-1 text-sm text-zinc-400">
				Manage your plan, payment methods, and invoices via Stripe.
			</p>
			{#if notice}
				<p class="mt-2 text-sm text-amber-400" role="status">{notice}</p>
			{/if}
		</div>
		<button
			onclick={openPortal}
			disabled={!configured}
			class="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/50 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
		>
			Manage in Stripe <ArrowRight class="h-4 w-4 text-zinc-500" />
		</button>
	</header>

	{#if $billing.isLoading}
		<div class="glass-panel rounded-xl border border-zinc-800 p-6 text-sm text-zinc-400">
			Loading billing status…
		</div>
	{:else if $billing.isError}
		<div
			class="glass-panel flex items-center gap-3 rounded-xl border border-red-500/30 p-6 text-sm text-red-300"
		>
			<AlertTriangle class="h-5 w-5 shrink-0 text-red-400" />
			Could not load billing status. Please refresh or try again later.
		</div>
	{:else if status}
		{#if !configured}
			<div
				class="mb-8 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5"
				role="status"
			>
				<AlertTriangle class="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
				<div class="text-sm">
					<p class="font-semibold text-amber-300">Stripe is not configured</p>
					<p class="mt-1 text-amber-200/80">
						This server has no Stripe credentials, so checkout, the billing portal, and invoices
						are unavailable. Set <code class="font-mono text-xs">STRIPE_SECRET_KEY</code>,
						<code class="font-mono text-xs">STRIPE_PRICE_ID</code> and
						<code class="font-mono text-xs">STRIPE_WEBHOOK_SECRET</code> in the server environment
						to enable billing. The workspace remains on the
						<span class="font-semibold">{planLabel}</span> plan.
					</p>
				</div>
			</div>
		{/if}

		<div class="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
			<!-- Current Plan Card (live data) -->
			<div
				class="glass-panel relative overflow-hidden rounded-xl border lg:col-span-2 {isPaid
					? 'border-indigo-500/30'
					: 'border-zinc-800'}"
			>
				{#if isPaid}
					<div
						class="pointer-events-none absolute top-0 right-0 h-64 w-64 translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500/10 blur-3xl"
					></div>
				{/if}

				<div class="relative z-10 flex h-full flex-col justify-between p-6">
					<div>
						<div class="mb-2 flex items-center justify-between">
							<h2 class="flex items-center gap-2 text-xl font-bold text-zinc-100">
								{planLabel}
								<span
									class="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase {statusBadgeClass}"
									>{status.status}</span
								>
							</h2>
						</div>
						{#if isPaid}
							<p class="mb-6 text-sm text-zinc-400">
								Your subscription is managed through Stripe. Pricing, seat counts and plan details
								live in the Stripe billing portal.
							</p>
						{:else}
							<p class="mb-6 text-sm text-zinc-400">
								This workspace is on the free tier. Upgrade to a paid plan to unlock the hosted
								subscription features.
							</p>
						{/if}
					</div>

					<div class="mt-8 flex items-center justify-between border-t border-zinc-800 pt-6 text-sm">
						<span class="text-zinc-500">
							{#if isPaid && status.currentPeriodEnd}
								Renews on {fmtDate(status.currentPeriodEnd)}
							{:else if status.status === 'canceled' && status.currentPeriodEnd}
								Access ends {fmtDate(status.currentPeriodEnd)}
							{:else}
								No active subscription
							{/if}
						</span>
						<button
							onclick={isPaid ? openPortal : openCheckout}
							disabled={!configured}
							class="font-medium text-indigo-400 transition-colors hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
							>{isPaid ? 'Change Plan' : 'Upgrade'}</button
						>
					</div>
				</div>
			</div>

			<!-- Payment Method (managed in Stripe — no card details are stored here) -->
			<div class="glass-panel flex flex-col justify-between rounded-xl border border-zinc-800 p-6">
				<div>
					<h3 class="mb-4 text-sm font-semibold tracking-wider text-zinc-300 uppercase">
						Payment Method
					</h3>
					<div class="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
						<div
							class="flex h-8 w-12 items-center justify-center rounded border border-zinc-700 bg-zinc-950"
						>
							<CreditCard class="h-6 w-6 text-zinc-400" />
						</div>
						<p class="text-xs text-zinc-500">
							{#if status.hasCustomer}
								Payment methods are stored securely in Stripe and managed via the billing portal.
							{:else}
								No payment method on file yet — one is added during checkout.
							{/if}
						</p>
					</div>
				</div>

				<button
					onclick={openPortal}
					disabled={!configured || !status.hasCustomer}
					class="mt-6 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
				>
					Update Payment Method
				</button>
			</div>
		</div>

		<!-- Invoice History (live from Stripe) -->
		<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
			<div class="flex items-center justify-between border-b border-zinc-800 p-6">
				<h2 class="text-lg font-semibold text-zinc-100">Invoice History</h2>
			</div>
			{#if $invoicesQuery.isLoading}
				<p class="p-6 text-sm text-zinc-400">Loading invoices…</p>
			{:else if $invoicesQuery.isError}
				<p class="p-6 text-sm text-red-300">Could not load invoices from Stripe.</p>
			{:else if invoices.length === 0}
				<p class="p-6 text-sm text-zinc-500">
					{configured ? 'No invoices yet.' : 'Invoices are unavailable until Stripe is configured.'}
				</p>
			{:else}
				<div class="overflow-x-auto">
					<table class="w-full text-left text-sm whitespace-nowrap">
						<thead class="bg-zinc-900/50 text-[10px] tracking-wider text-zinc-400 uppercase">
							<tr>
								<th class="px-6 py-3 font-semibold">Date</th>
								<th class="px-6 py-3 font-semibold">Invoice #</th>
								<th class="px-6 py-3 font-semibold">Amount</th>
								<th class="px-6 py-3 font-semibold">Status</th>
								<th class="px-6 py-3 text-right font-semibold">Action</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-zinc-800/50 text-zinc-300">
							{#each invoices as inv, i (inv.id)}
								{@const invoiceUrl = inv.invoicePdf ?? inv.hostedInvoiceUrl}
								<tr
									in:fly={{ y: 6, duration: 200, delay: i * 30 }}
									class="transition-colors hover:bg-zinc-900/30"
								>
									<td class="px-6 py-4">{fmtDate(inv.created)}</td>
									<td class="px-6 py-4 font-mono text-xs text-zinc-500">{inv.number ?? inv.id}</td>
									<td class="px-6 py-4">{fmtAmount(inv.total, inv.currency)}</td>
									<td class="px-6 py-4">
										<span
											class="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium capitalize {inv.status ===
											'paid'
												? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
												: inv.status === 'open'
													? 'border-amber-500/20 bg-amber-500/10 text-amber-400'
													: 'border-zinc-700 bg-zinc-800/50 text-zinc-400'}"
										>
											{inv.status}
										</span>
									</td>
									<td class="px-6 py-4 text-right">
										{#if invoiceUrl}
											<a
												href={invoiceUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex items-center gap-2 rounded-md p-2 text-zinc-400 transition-colors hover:bg-indigo-500/10 hover:text-indigo-400"
												aria-label="Download invoice {inv.number ?? inv.id}"
											>
												<Download class="h-4 w-4" /> <span class="text-xs">PDF</span>
											</a>
										{:else}
											<span class="text-xs text-zinc-600">—</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</div>

<script lang="ts">
	import { CreditCard, CheckCircle2, Download, ArrowRight } from '@lucide/svelte';
	import { fly } from 'svelte/transition';

	// Inline plan / invoice data — no billing endpoint yet (prototype spec).
	const planFeatures = [
		'100 User Seats (42 active)',
		'500GB Vector Storage',
		'Advanced Contradiction Engine',
		'SLA & Priority Support'
	];

	const invoices = [
		{ date: 'May 18, 2026', number: 'INV-2026-001', amount: '$999.00', status: 'Paid' },
		{ date: 'Apr 18, 2026', number: 'INV-2026-002', amount: '$999.00', status: 'Paid' },
		{ date: 'Mar 18, 2026', number: 'INV-2026-003', amount: '$999.00', status: 'Paid' }
	];
</script>

<div class="max-w-5xl p-6 md:p-8">
	<header class="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
		<div>
			<h1 class="text-2xl font-bold tracking-tight text-zinc-100">Billing & Subscriptions</h1>
			<p class="mt-1 text-sm text-zinc-400">
				Manage your enterprise plan, payment methods, and invoices.
			</p>
		</div>
		<button
			class="flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900/50 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
		>
			Manage in Stripe <ArrowRight class="h-4 w-4 text-zinc-500" />
		</button>
	</header>

	<div class="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
		<!-- Current Plan Card -->
		<div
			class="glass-panel relative overflow-hidden rounded-xl border border-indigo-500/30 lg:col-span-2"
		>
			<div
				class="pointer-events-none absolute top-0 right-0 h-64 w-64 translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500/10 blur-3xl"
			></div>

			<div class="relative z-10 flex h-full flex-col justify-between p-6">
				<div>
					<div class="mb-2 flex items-center justify-between">
						<h2 class="flex items-center gap-2 text-xl font-bold text-zinc-100">
							Enterprise
							<span
								class="rounded-full bg-indigo-500/20 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-indigo-400 uppercase"
								>Active</span
							>
						</h2>
						<span class="text-2xl font-bold text-zinc-100"
							>$999<span class="text-sm font-normal text-zinc-500">/mo</span></span
						>
					</div>
					<p class="mb-6 text-sm text-zinc-400">
						Unlimited domain folders, full SSOT pipeline, and priority Copilot SDK routing.
					</p>

					<div class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm text-zinc-300 sm:grid-cols-2">
						{#each planFeatures as feature (feature)}
							<div class="flex items-center gap-2">
								<CheckCircle2 class="h-4 w-4 text-indigo-400" />
								{feature}
							</div>
						{/each}
					</div>
				</div>

				<div class="mt-8 flex items-center justify-between border-t border-zinc-800 pt-6 text-sm">
					<span class="text-zinc-500">Renews on June 18, 2026</span>
					<button class="font-medium text-indigo-400 transition-colors hover:text-indigo-300"
						>Change Plan</button
					>
				</div>
			</div>
		</div>

		<!-- Payment Method -->
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
					<div>
						<p class="text-sm font-medium text-zinc-200">•••• 4242</p>
						<p class="text-xs text-zinc-500">Expires 12/28</p>
					</div>
				</div>
			</div>

			<button
				class="mt-6 w-full rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-800"
			>
				Update Payment Method
			</button>
		</div>
	</div>

	<!-- Invoice History -->
	<section class="glass-panel overflow-hidden rounded-xl border border-zinc-800">
		<div class="flex items-center justify-between border-b border-zinc-800 p-6">
			<h2 class="text-lg font-semibold text-zinc-100">Invoice History</h2>
		</div>
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
					{#each invoices as inv, i (inv.number)}
						<tr in:fly={{ y: 6, duration: 200, delay: i * 30 }} class="transition-colors hover:bg-zinc-900/30">
							<td class="px-6 py-4">{inv.date}</td>
							<td class="px-6 py-4 font-mono text-xs text-zinc-500">{inv.number}</td>
							<td class="px-6 py-4">{inv.amount}</td>
							<td class="px-6 py-4">
								<span
									class="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-400"
								>
									{inv.status}
								</span>
							</td>
							<td class="px-6 py-4 text-right">
								<button
									class="inline-flex items-center gap-2 rounded-md p-2 text-zinc-400 transition-colors hover:bg-indigo-500/10 hover:text-indigo-400"
									aria-label="Download invoice {inv.number}"
								>
									<Download class="h-4 w-4" /> <span class="text-xs">PDF</span>
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</div>

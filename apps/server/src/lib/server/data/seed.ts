import type {
	AuditLog,
	CoverageRow,
	DeltaEntry,
	Document,
	EvaluationMetrics,
	Flashcard,
	Folder,
	Graph,
	Notification,
	Ontology,
	Organization,
	ProcessingJob,
	ReviewItem,
	Source,
	Topic,
	UsageMetrics,
	User
} from '@insightlibrary/schemas';

/**
 * Seed data transcribed from the prototype's lib/mock-data.ts. This is the
 * canonical development dataset: the in-memory repository serves it directly,
 * and the Postgres seeder inserts it. Medical example content is unchanged so
 * the rebuilt screens match the prototype 1:1.
 */

export const seedOrg: Organization = {
	id: 'org_1',
	name: 'InsightLibrary Demo',
	slug: 'demo',
	tenantId: '9021'
};

export const seedUsers: User[] = [
	{
		id: 'u_1',
		name: 'System Admin',
		email: 'admin@insightlibrary.ai',
		role: 'owner',
		initials: 'IL',
		lastActive: 'now'
	},
	{
		id: 'u_2',
		name: 'Dr. Sara Kamal',
		email: 'sara@insightlibrary.ai',
		role: 'editor',
		initials: 'SK',
		lastActive: '2 hours ago'
	},
	{
		id: 'u_3',
		name: 'Omar Reader',
		email: 'omar@insightlibrary.ai',
		role: 'viewer',
		initials: 'OR',
		lastActive: '1 day ago'
	}
];

export const seedFolders: Folder[] = [
	{ id: 'f1', name: 'USMLE Step 1 Prep', docs: 12, topics: 430, health: 92, lastUpdated: '2 hours ago' },
	{ id: 'f2', name: 'Radiology Core', docs: 5, topics: 112, health: 85, lastUpdated: '1 day ago' },
	{ id: 'f3', name: 'Internal Medicine SOPs', docs: 28, topics: 1205, health: 76, lastUpdated: '3 days ago' }
];

export const seedDocuments: Document[] = [
	{ id: 'doc1', title: 'Pathoma Fundamentals', status: 'indexed', statusLabel: 'Indexed', pages: 300, topics: 154, type: 'pdf', folderId: 'f1', uploadedAt: '2024-05-10' },
	{ id: 'doc2', title: 'First Aid 2024', status: 'indexed', statusLabel: 'Indexed', pages: 850, topics: 210, type: 'pdf', folderId: 'f1', uploadedAt: '2024-05-12' },
	{ id: 'doc3', title: 'Clinical Radiology Guidelines', status: 'processing', statusLabel: 'Processing (OCR)', pages: 120, topics: 0, type: 'pdf', folderId: 'f2', uploadedAt: '2024-05-17' },
	{ id: 'doc4', title: 'Endocrine Block Notes', status: 'needs_review', statusLabel: 'Needs Review', pages: 45, topics: 12, type: 'docx', folderId: 'f1', uploadedAt: '2024-05-16' }
];

export const seedSources: Source[] = [
	{ id: 'bk-A', name: 'Book A: Basic Sciences', author: 'Dr. Smith', type: 'Textbook', priority: 3, date: '2023' },
	{ id: 'bk-B', name: 'Book B: Clinical Endo', author: 'Dr. Jones', type: 'Textbook', priority: 2, date: '2024' },
	{ id: 'bk-C', name: 'Book C: Rad Core', author: 'Dr. Ahmed', type: 'Textbook', priority: 2, date: '2024' },
	{ id: 'bk-D', name: 'Book D: Board Pearls', author: 'MedReview', type: 'Review Guide', priority: 4, date: '2025' }
];

export const seedTopics: Topic[] = [
	{
		id: 'addisons-disease',
		name: "Addison's Disease",
		aliases: ['Primary adrenal insufficiency', 'Hypoadrenalism'],
		health: 82,
		updates: 4,
		folder: 'USMLE Step 1 Prep',
		lastUpdated: '2 hours ago',
		sections: [
			{
				id: 's1',
				title: 'Anatomy',
				icon: 'FlaskConical',
				claims: [
					{ id: 'c1', content: 'The adrenal glands are situated at the superior pole of each kidney.', citations: ['bk-A', 'p12'] },
					{ id: 'c2', content: 'The adrenal cortex is divided into three zones: glomerulosa, fasciculata, reticularis.', citations: ['bk-A', 'p14'] }
				]
			},
			{
				id: 's2',
				title: 'Physiology',
				icon: 'Activity',
				claims: [
					{ id: 'c3', content: 'Zona glomerulosa produces aldosterone, regulated by the RAAS system.', citations: ['bk-A', 'p18'] },
					{ id: 'c4', content: 'Zona fasciculata produces cortisol, regulated by ACTH from the pituitary.', citations: ['bk-A', 'p19', 'bk-B', 'p50'] }
				]
			},
			{
				id: 's3',
				title: 'Pharmacology',
				icon: 'Pill',
				claims: [
					{ id: 'c5', content: 'Glucocorticoid replacement is required, typically hydrocortisone (15-25mg/day).', citations: ['bk-B', 'p55'] },
					{ id: 'c6', content: 'Fludrocortisone needed for mineralocorticoid replacement in primary insufficiency.', citations: ['bk-B', 'p56', 'bk-D', 'p210'] }
				]
			},
			{
				id: 's4',
				title: 'Radiology',
				icon: 'Stethoscope',
				claims: [
					{ id: 'c7', content: 'CT may show bilateral adrenal enlargement in early TB, or small calcified glands in late autoimmune disease.', citations: ['bk-C', 'p112'] }
				]
			},
			{
				id: 's5',
				title: 'Exam Pearls',
				icon: 'Zap',
				claims: [
					{ id: 'c8', content: 'Hyperpigmentation distinguishes primary from secondary insufficiency (due to elevated POMC/ACTH).', citations: ['bk-B', 'p60', 'bk-D', 'p212'] },
					{ id: 'c9', content: 'Check for associated autoimmune conditions (Type 1 or 2 polyglandular autoimmune syndromes).', citations: ['bk-D', 'p213'] }
				]
			},
			{
				id: 's6',
				title: 'Etiology',
				icon: 'Dna',
				claims: [
					{ id: 'c10', content: 'Most common cause in developed countries is autoimmune adrenalitis (80-90% of cases).', citations: ['bk-B', 'p42'] },
					{ id: 'c11', content: 'Tuberculosis remains the most common global cause of primary adrenal insufficiency.', citations: ['bk-A', 'p22', 'bk-D', 'p208'] }
				]
			},
			{
				id: 's7',
				title: 'Epidemiology',
				icon: 'Users',
				claims: [
					{ id: 'c12', content: 'Prevalence is approximately 100 to 140 cases per million population.', citations: ['bk-B', 'p44'] },
					{ id: 'c13', content: "Autoimmune Addison's disease is more common in females than in males (ratio 2:1 to 3:1).", citations: ['bk-B', 'p45'] }
				]
			}
		]
	},
	{ id: 'cushings-syndrome', name: "Cushing's Syndrome", aliases: ['Hypercortisolism'], health: 95, updates: 0, folder: 'USMLE Step 1 Prep', lastUpdated: '1 day ago', sections: [] },
	{ id: 'hypothyroidism', name: 'Hypothyroidism', aliases: ['Underactive thyroid'], health: 70, updates: 12, folder: 'USMLE Step 1 Prep', lastUpdated: '5 hours ago', sections: [] },
	{ id: 'chest-xray-basics', name: 'Chest X-Ray Interpretation', aliases: ['CXR Basics'], health: 45, updates: 30, folder: 'Radiology Core', lastUpdated: '3 days ago', sections: [] }
];

export const seedCoverage: CoverageRow[] = [
	{ aspect: 'Anatomy', bA: 'Strong', bB: 'Weak', bC: 'None', bD: 'None', status: 'Covered' },
	{ aspect: 'Physiology', bA: 'Strong', bB: 'Medium', bC: 'None', bD: 'Weak', status: 'Covered' },
	{ aspect: 'Etiology', bA: 'Medium', bB: 'Strong', bC: 'None', bD: 'Strong', status: 'Covered' },
	{ aspect: 'Epidemiology', bA: 'None', bB: 'Strong', bC: 'None', bD: 'None', status: 'Covered' },
	{ aspect: 'Pharmacology', bA: 'None', bB: 'Strong', bC: 'None', bD: 'Medium', status: 'Covered' },
	{ aspect: 'Radiology', bA: 'None', bB: 'None', bC: 'Strong', bD: 'Medium', status: 'Needs expansion' },
	{ aspect: 'Exam Pearls', bA: 'Medium', bB: 'Medium', bC: 'Weak', bD: 'Strong', status: 'Improved' }
];

export const seedDelta: DeltaEntry[] = [
	{ id: 'd1', type: 'duplicate', text: '129 duplicate claims skipped', details: 'Already mapped' },
	{ id: 'd2', type: 'citation', text: '21 supporting citations added', details: 'Bolstered existing claims' },
	{ id: 'd3', type: 'expand', text: '5 expanded claims merged', details: 'Added depth to Pharmacology' },
	{ id: 'd4', type: 'new', text: '9 new unique claims added', details: 'Added Exam Pearls' },
	{ id: 'd5', type: 'conflict', text: '2 contradictions sent to review', details: 'Pending resolution' }
];

export const seedReview: ReviewItem[] = [
	{
		id: 'r1',
		topic: "Addison's disease",
		type: 'conflict',
		status: 'pending',
		originalClaim: 'Hydrocortisone dosing is typically 15-25mg/day divided in two doses.',
		newClaim: 'Hydrocortisone dosing should be 20-30mg/day divided in three doses to mimic physiological rhythm.',
		sourceA: 'bk-B, p55 (2024)',
		sourceB: 'bk-D, p214 (2025)',
		confidence: 'Medium',
		notes: 'Newer source suggests 3-times daily dosing. Manual review required.'
	},
	{
		id: 'r2',
		topic: 'Hypothyroidism',
		type: 'new',
		status: 'pending',
		originalClaim: null,
		newClaim: 'Subclinical hypothyroidism with TSH > 10 mIU/L should generally be treated regardless of symptoms.',
		sourceA: null,
		sourceB: 'bk-D, p180 (2025)',
		confidence: 'High',
		notes: 'New authoritative claim without existing counterpart.'
	}
];

export const seedFlashcards: Flashcard[] = [
	{ id: 'fc1', topicId: 'addisons-disease', topic: "Addison's disease", front: 'What distinguishes primary from secondary adrenal insufficiency?', back: 'Hyperpigmentation (due to elevated POMC/ACTH) is present in primary, absent in secondary.' },
	{ id: 'fc2', topicId: 'addisons-disease', topic: "Addison's disease", front: 'Which zone of the adrenal cortex produces aldosterone?', back: 'Zona glomerulosa' },
	{ id: 'fc3', topicId: 'addisons-disease', topic: "Addison's disease", front: 'What is the most common etiology of primary adrenal insufficiency in developed countries?', back: 'Autoimmune adrenalitis (80-90% of cases)' }
];

export const seedGraph: Graph = {
	nodes: [
		{ id: 'Addisons', group: 'Disease', size: 30 },
		{ id: 'Adrenal Cortex', group: 'Anatomy', size: 20 },
		{ id: 'Cortisol', group: 'Hormone', size: 25 },
		{ id: 'ACTH', group: 'Hormone', size: 25 },
		{ id: 'Hyperpigmentation', group: 'Symptom', size: 15 },
		{ id: 'Autoimmune Adrenalitis', group: 'Etiology', size: 20 }
	],
	edges: [
		{ source: 'Addisons', target: 'Adrenal Cortex', label: 'AFFECTS' },
		{ source: 'Addisons', target: 'Cortisol', label: 'DEFICIENCY' },
		{ source: 'ACTH', target: 'Cortisol', label: 'STIMULATES' },
		{ source: 'Addisons', target: 'ACTH', label: 'INCREASES (Primary)' },
		{ source: 'ACTH', target: 'Hyperpigmentation', label: 'CAUSES' },
		{ source: 'Autoimmune Adrenalitis', target: 'Addisons', label: 'MOST_COMMON_CAUSE' }
	]
};

export const seedUsage: UsageMetrics = {
	monthlyBudget: 5000,
	currentSpend: 1240.5,
	queries: 14205,
	costPerQuery: 0.08,
	activeUsers: 84,
	storageGB: 120,
	events: [
		{ name: 'Answers Generated', count: 12405, cost: 840.2 },
		{ name: 'Delta Extractions', count: 320, cost: 210.0 },
		{ name: 'Reranking (ColBERT)', count: 14205, cost: 142.05 },
		{ name: 'Graph Community Builds', count: 15, cost: 48.25 }
	]
};

export const seedEvaluation: EvaluationMetrics = {
	faithfulness: 96.4,
	citationAccuracy: 98.2,
	hallucinationRate: 1.1,
	noveltyPrecision: 88.5,
	recentTests: [
		{ query: 'What is the typical dose of hydrocortisone?', mode: 'Strict Citation', status: 'Pass', faithfulness: 1.0 },
		{ query: "How does Addison's present on MRI?", mode: 'Standard', status: 'Warning', faithfulness: 0.8 },
		{ query: 'Summarize Chapter 4 of Book D', mode: 'RAPTOR Outline', status: 'Pass', faithfulness: 0.95 }
	]
};

export const seedProcessing: ProcessingJob[] = [
	{ id: 'job1', documentId: 'doc3', documentTitle: 'Clinical Radiology Guidelines', stage: 'extract', progress: 40, startedAt: '5 min ago', message: 'OCR text extraction in progress' },
	{ id: 'job2', documentId: 'doc4', documentTitle: 'Endocrine Block Notes', stage: 'index', progress: 88, startedAt: '12 min ago', message: 'Building FTS + vector index' }
];

export const seedAudit: AuditLog[] = [
	{ id: 'a1', actor: 'System Admin', action: 'ssot.merge', target: "Addison's Disease", timestamp: '2 mins ago', severity: 'info' },
	{ id: 'a2', actor: 'Dr. Sara Kamal', action: 'document.upload', target: 'Endocrine Block Notes', timestamp: '16 mins ago', severity: 'info' },
	{ id: 'a3', actor: 'System', action: 'conflict.detected', target: "Addison's Disease", timestamp: '1 hour ago', severity: 'warning' },
	{ id: 'a4', actor: 'System Admin', action: 'user.role_change', target: 'Omar Reader → viewer', timestamp: '1 day ago', severity: 'critical' }
];

export const seedOntologies: Ontology[] = [
	{ id: 'onto1', name: 'Medical (SNOMED-lite)', entities: 1240, relations: 3200, status: 'active', lastUpdated: '2 days ago' },
	{ id: 'onto2', name: 'Radiology Findings', entities: 340, relations: 810, status: 'active', lastUpdated: '1 week ago' },
	{ id: 'onto3', name: 'Pharmacology Draft', entities: 92, relations: 140, status: 'draft', lastUpdated: '3 weeks ago' }
];

export const seedNotifications: Notification[] = [
	{ id: 'n1', type: 'ssot_merge', title: 'SSOT Merge Complete', description: "Book D claims successfully merged into Addison's Disease SSOT.", time: '2 mins ago', read: false, action: null },
	{ id: 'n2', type: 'conflict', title: 'Contradiction Detected', description: 'Treatment contradictions found in latest upload. Human review required.', time: '1 hour ago', read: false, action: 'Review Conflict' },
	{ id: 'n3', type: 'novelty', title: 'New Knowledge Extracted', description: "9 new unique claims identified in 'USMLE Step 1' folder.", time: '3 hours ago', read: true, action: null },
	{ id: 'n4', type: 'alert', title: 'API Quota Warning', description: 'You have reached 80% of your AI token budget for this month.', time: '1 day ago', read: true, action: null }
];

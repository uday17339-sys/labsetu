/**
 * The complete permission vocabulary.
 *
 * Routes declare permissions with @RequirePermissions(...). A route that
 * declares none is DENIED, not open — deny-by-default is the only posture that
 * survives a growing codebase.
 */
export const PERMISSIONS = {
  // --- patients -------------------------------------------------------------
  PATIENT_READ: 'patient:read',
  PATIENT_CREATE: 'patient:create',
  PATIENT_UPDATE: 'patient:update',
  /// Decrypting and viewing identifiers is itself a logged, permissioned act.
  PATIENT_READ_PII: 'patient:read_pii',
  PATIENT_ERASE: 'patient:erase',

  // --- orders & samples -----------------------------------------------------
  ORDER_READ: 'order:read',
  ORDER_CREATE: 'order:create',
  ORDER_UPDATE: 'order:update',
  ORDER_CANCEL: 'order:cancel',

  SAMPLE_READ: 'sample:read',
  SAMPLE_CREATE: 'sample:create',
  SAMPLE_COLLECT: 'sample:collect',
  SAMPLE_RECEIVE: 'sample:receive',
  SAMPLE_REJECT: 'sample:reject',

  // --- results --------------------------------------------------------------
  RESULT_READ: 'result:read',
  RESULT_ENTER: 'result:enter',
  /// Technical verification — the first of the two release steps.
  RESULT_VERIFY: 'result:verify',
  /// Medical authorisation — requires an electronic signature.
  RESULT_AUTHORIZE: 'result:authorize',
  RESULT_AMEND: 'result:amend',
  RESULT_RERUN: 'result:rerun',
  /// Record that a critical value was telephoned through to the clinician.
  /// Separate from RESULT_ENTER: whoever makes the call may not be the person
  /// who produced the value, and NABL wants the caller named.
  RESULT_CALLBACK: 'result:callback',

  // --- reports --------------------------------------------------------------
  REPORT_READ: 'report:read',
  REPORT_GENERATE: 'report:generate',
  REPORT_RELEASE: 'report:release',
  REPORT_AMEND: 'report:amend',
  REPORT_DELIVER: 'report:deliver',

  // --- catalog --------------------------------------------------------------
  CATALOG_READ: 'catalog:read',
  CATALOG_MANAGE: 'catalog:manage',

  // --- quality control ------------------------------------------------------
  QC_READ: 'qc:read',
  QC_ENTER: 'qc:enter',
  QC_OVERRIDE: 'qc:override',
  /// Register control materials and lots with their target mean and SD.
  /// Separate from QC_ENTER: setting the target is what defines pass and fail,
  /// so the bench that runs the control should not also be able to move the
  /// goalposts.
  QC_MANAGE: 'qc:manage',

  // --- instruments ----------------------------------------------------------
  DEVICE_READ: 'device:read',
  DEVICE_MANAGE: 'device:manage',
  DEVICE_ENROL: 'device:enrol',
  INGEST_EXCEPTION_RESOLVE: 'ingest:resolve',

  // --- inventory ------------------------------------------------------------
  INVENTORY_READ: 'inventory:read',
  /// Receive, adjust and dispose of stock.
  INVENTORY_MANAGE: 'inventory:manage',
  /// Record consumption. Held by bench staff, who use reagents but do not
  /// order or write them off.
  INVENTORY_CONSUME: 'inventory:consume',

  // --- billing --------------------------------------------------------------
  INVOICE_READ: 'invoice:read',
  INVOICE_CREATE: 'invoice:create',
  INVOICE_CANCEL: 'invoice:cancel',
  PAYMENT_RECORD: 'payment:record',

  // --- administration -------------------------------------------------------
  USER_READ: 'user:read',
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  COMPETENCY_MANAGE: 'competency:manage',
  LAB_MANAGE: 'lab:manage',
  POLICY_MANAGE: 'policy:manage',

  // --- manufacturing QC: stores ---------------------------------------------
  /// See the material master, batches and their status.
  STORES_READ: 'stores:read',
  /// Receive a consignment, move stock between locations, issue to production.
  STORES_MANAGE: 'stores:manage',
  /// Create and amend the material master itself. Separate from receiving:
  /// the storekeeper books goods in daily, but defining what a material IS is
  /// a controlled change.
  MATERIAL_MANAGE: 'material:manage',
  /// Ask QC to sample a quarantined batch.
  SAMPLING_REQUEST: 'sampling:request',
  /// Draw the sample and raise the test order against the batch.
  SAMPLING_PERFORM: 'sampling:perform',

  // --- manufacturing QC: specifications --------------------------------------
  SPEC_READ: 'spec:read',
  /// Author a draft specification.
  SPEC_MANAGE: 'spec:manage',
  /// Approve a draft so it governs testing. Deliberately distinct from
  /// authoring — the person who writes the acceptance criteria must not be the
  /// only person who decides they apply.
  SPEC_APPROVE: 'spec:approve',

  // --- manufacturing QC: quality assurance -----------------------------------
  /// Release or reject a batch. The gate between the laboratory and the
  /// factory floor, and the reason QA exists as a role separate from QC.
  BATCH_DISPOSITION: 'batch:disposition',

  // --- quality system ---
  DEVIATION_READ: 'deviation:read',
  /// Deliberately wide. A deviation nobody felt able to report is the most
  /// expensive kind; the controls that matter are on closing one, not on
  /// noticing it.
  DEVIATION_RAISE: 'deviation:raise',
  DEVIATION_MANAGE: 'deviation:manage',
  DEVIATION_CLOSE: 'deviation:close',
  CAPA_READ: 'capa:read',
  CAPA_MANAGE: 'capa:manage',
  /// Separate from CAPA_MANAGE: whoever did the work should not be the one
  /// certifying it worked. Same reasoning as four-eyes on a result.
  CAPA_VERIFY: 'capa:verify',
  CHANGE_READ: 'change:read',
  CHANGE_REQUEST: 'change:request',
  CHANGE_APPROVE: 'change:approve',
  STABILITY_READ: 'stability:read',
  STABILITY_MANAGE: 'stability:manage',
  EM_READ: 'em:read',
  /// Recording a reading is separate from configuring the programme: an
  /// operator takes plates, a QA lead sets what the limits are.
  EM_RECORD: 'em:record',
  EM_MANAGE: 'em:manage',
  PQR_READ: 'pqr:read',
  /// Open, progress and close an out-of-specification investigation.
  OOS_MANAGE: 'oos:manage',
  /// Issue a certificate of analysis for a released batch.
  COA_ISSUE: 'coa:issue',

  // --- business reporting ---------------------------------------------------
  /// Revenue, test mix and referral performance. Deliberately distinct from
  /// clinical reads — an owner or accountant needs the money view without
  /// getting access to patient results, and vice versa.
  ANALYTICS_READ: 'analytics:read',

  // --- compliance -----------------------------------------------------------
  AUDIT_READ: 'audit:read',
  AUDIT_VERIFY: 'audit:verify',
  COMPLIANCE_EXPORT: 'compliance:export',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

/**
 * Permissions that are DECLARED and grantable but have no endpoint behind them
 * yet. The modules are on the roadmap; the vocabulary is fixed now so role
 * definitions do not have to be rewritten when they land.
 *
 * Listed explicitly rather than left to be discovered, because a permission
 * that grants nothing is exactly the kind of thing that turns into "…and that
 * screen doesn't exist yet" in front of a customer. `scripts/traceability.mjs`
 * reads this set, so anything enforced later must be removed from here or the
 * audit will flag the inconsistency.
 */
export const UNIMPLEMENTED_PERMISSIONS: readonly Permission[] = [
  // --- tenant-level configuration (Phase 2) ---
  // Branches, letterheads, TAT policies and signing rules are seeded per tenant
  // and changed by us during onboarding. Self-service configuration is real
  // work, not a screen, so it is scoped rather than half-built.
  PERMISSIONS.LAB_MANAGE,
  PERMISSIONS.POLICY_MANAGE,

  // --- instrument administration (Phase 2) ---
  // --- workflow actions not yet exposed ---
  PERMISSIONS.ORDER_UPDATE,
  PERMISSIONS.ORDER_CANCEL,
  PERMISSIONS.SAMPLE_CREATE, // samples are created with the order, not standalone
  PERMISSIONS.RESULT_AMEND, // report-level amendment exists; per-result does not
  PERMISSIONS.INVOICE_CREATE, // invoices are raised automatically with the order
  PERMISSIONS.REPORT_DELIVER, // delivery is queued on release, not re-sendable
] as const;

/**
 * Default role templates seeded per tenant.
 *
 * Two families, because the product serves two kinds of laboratory:
 *
 * DIAGNOSTICS — pathologist, technician, phlebotomist, front desk, accounts.
 * Note what the pathologist can do that the technician cannot: authorise. That
 * separation is the four-eyes principle expressed as roles.
 *
 * MANUFACTURING QC — stores, QC analyst, QA. The separation that matters here
 * is different and stricter: QC produces the result, QA decides what it means
 * for the batch. A QC analyst can test all day and cannot release a gram of
 * material; QA can release and cannot enter a result. Collapsing the two into
 * one "quality" role is the single most common finding in a GMP inspection, so
 * the software does not offer it.
 *
 * AUDITOR spans both and changes nothing — an assessor needs to see everything.
 */
export const DEFAULT_ROLES: Record<
  string,
  { name: string; description: string; permissions: Permission[] }
> = {
  LAB_ADMIN: {
    name: 'Lab Administrator',
    description: 'Full administrative access within the tenant',
    permissions: ALL_PERMISSIONS,
  },
  PATHOLOGIST: {
    name: 'Pathologist / Consultant',
    description: 'Medically authorises and releases reports',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_READ_PII,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SAMPLE_READ,
      PERMISSIONS.RESULT_READ,
      PERMISSIONS.RESULT_ENTER,
      PERMISSIONS.RESULT_VERIFY,
      PERMISSIONS.RESULT_AUTHORIZE,
      PERMISSIONS.RESULT_AMEND,
      PERMISSIONS.RESULT_RERUN,
      PERMISSIONS.RESULT_CALLBACK,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_GENERATE,
      PERMISSIONS.REPORT_RELEASE,
      PERMISSIONS.REPORT_AMEND,
      PERMISSIONS.REPORT_DELIVER,
      PERMISSIONS.CATALOG_READ,
      PERMISSIONS.QC_READ,
      PERMISSIONS.QC_ENTER,
      PERMISSIONS.QC_OVERRIDE,
      // The pathologist signs off the quality system, so they set control
      // targets. The bench runs the control; it does not move the target.
      PERMISSIONS.QC_MANAGE,
      PERMISSIONS.DEVICE_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.INVENTORY_READ,
      // Competency is a clinical judgement about whether someone may perform a
      // test, not an HR function — it belongs with the person who is medically
      // accountable for the result.
      PERMISSIONS.COMPETENCY_MANAGE,
      PERMISSIONS.USER_READ,
      PERMISSIONS.CATALOG_MANAGE,
    ],
  },
  LAB_TECHNICIAN: {
    name: 'Lab Technician',
    description: 'Processes samples and enters results; cannot authorise',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SAMPLE_READ,
      // Bench staff routinely draw samples too, especially in small and
      // mid-size labs where there is no dedicated phlebotomy shift.
      PERMISSIONS.SAMPLE_COLLECT,
      PERMISSIONS.SAMPLE_RECEIVE,
      PERMISSIONS.SAMPLE_REJECT,
      PERMISSIONS.RESULT_READ,
      PERMISSIONS.RESULT_ENTER,
      PERMISSIONS.RESULT_VERIFY,
      PERMISSIONS.RESULT_RERUN,
      // The bench is usually who actually picks up the phone at 2am.
      PERMISSIONS.RESULT_CALLBACK,
      PERMISSIONS.CATALOG_READ,
      PERMISSIONS.QC_READ,
      PERMISSIONS.QC_ENTER,
      PERMISSIONS.DEVICE_READ,
      PERMISSIONS.INGEST_EXCEPTION_RESOLVE,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_CONSUME,
    ],
  },
  PHLEBOTOMIST: {
    name: 'Phlebotomist',
    description: 'Collects samples',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_READ_PII,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SAMPLE_READ,
      PERMISSIONS.SAMPLE_CREATE,
      PERMISSIONS.SAMPLE_COLLECT,
      PERMISSIONS.CATALOG_READ,
    ],
  },
  RECEPTIONIST: {
    name: 'Front Desk',
    description: 'Registers patients, books orders, collects payment',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.PATIENT_READ_PII,
      PERMISSIONS.PATIENT_CREATE,
      PERMISSIONS.PATIENT_UPDATE,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.ORDER_CREATE,
      PERMISSIONS.ORDER_UPDATE,
      PERMISSIONS.SAMPLE_READ,
      PERMISSIONS.SAMPLE_CREATE,
      PERMISSIONS.CATALOG_READ,
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.INVOICE_CREATE,
      PERMISSIONS.PAYMENT_RECORD,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_DELIVER,
    ],
  },
  ACCOUNTANT: {
    name: 'Accounts',
    description: 'Billing and collections',
    permissions: [
      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.INVOICE_CREATE,
      PERMISSIONS.INVOICE_CANCEL,
      PERMISSIONS.PAYMENT_RECORD,
      PERMISSIONS.CATALOG_READ,
      // The whole point of the role. Deliberately paired with no RESULT_READ:
      // accounts needs the revenue, not the diagnoses.
      PERMISSIONS.ANALYTICS_READ,
    ],
  },
  // --- manufacturing QC ------------------------------------------------------

  STORES: {
    name: 'Stores',
    description:
      'Receives raw materials and holds finished product. Books goods in, moves stock, and requests QC sampling. Cannot release material — that is QA.',
    permissions: [
      PERMISSIONS.DEVIATION_READ,
      PERMISSIONS.DEVIATION_RAISE,

      PERMISSIONS.STORES_READ,
      PERMISSIONS.STORES_MANAGE,
      PERMISSIONS.SAMPLING_REQUEST,
      // Reads the specification so the storekeeper can see what a material is
      // meant to be, but cannot author or approve one.
      PERMISSIONS.SPEC_READ,
      PERMISSIONS.CATALOG_READ,
      // The lab's own consumables, which stores also holds.
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_MANAGE,
      // Deliberately absent: BATCH_DISPOSITION. Stores physically segregates
      // quarantined material; it does not decide the material is good.
    ],
  },
  QC_ANALYST: {
    name: 'QC Analyst',
    description:
      'Samples batches and performs the testing against specification. Produces results; does not decide their consequence for the batch.',
    permissions: [
      PERMISSIONS.EM_READ,
      PERMISSIONS.EM_RECORD,

      PERMISSIONS.STABILITY_READ,
      PERMISSIONS.STABILITY_MANAGE,

      PERMISSIONS.DEVIATION_READ,
      PERMISSIONS.DEVIATION_RAISE,
      PERMISSIONS.CAPA_READ,
      PERMISSIONS.CHANGE_READ,

      PERMISSIONS.STORES_READ,
      PERMISSIONS.SAMPLING_PERFORM,
      PERMISSIONS.SPEC_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SAMPLE_READ,
      PERMISSIONS.SAMPLE_COLLECT,
      PERMISSIONS.SAMPLE_RECEIVE,
      PERMISSIONS.SAMPLE_REJECT,
      PERMISSIONS.RESULT_READ,
      PERMISSIONS.RESULT_ENTER,
      PERMISSIONS.RESULT_VERIFY,
      PERMISSIONS.RESULT_RERUN,
      PERMISSIONS.CATALOG_READ,
      PERMISSIONS.QC_READ,
      PERMISSIONS.QC_ENTER,
      PERMISSIONS.DEVICE_READ,
      PERMISSIONS.INGEST_EXCEPTION_RESOLVE,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.INVENTORY_CONSUME,
      // Deliberately absent: RESULT_AUTHORIZE and BATCH_DISPOSITION. The
      // analyst who generated a number is not the person who signs it off.
    ],
  },
  QA: {
    name: 'Quality Assurance',
    description:
      'Approves specifications, investigates out-of-specification results, and releases or rejects batches. Independent of the analyst who produced the result.',
    permissions: [
      PERMISSIONS.PQR_READ,

      PERMISSIONS.EM_READ,
      PERMISSIONS.EM_RECORD,
      PERMISSIONS.EM_MANAGE,

      PERMISSIONS.STABILITY_READ,
      PERMISSIONS.STABILITY_MANAGE,

      PERMISSIONS.DEVIATION_READ,
      PERMISSIONS.DEVIATION_RAISE,
      PERMISSIONS.DEVIATION_MANAGE,
      PERMISSIONS.DEVIATION_CLOSE,
      PERMISSIONS.CAPA_READ,
      PERMISSIONS.CAPA_MANAGE,
      PERMISSIONS.CAPA_VERIFY,
      PERMISSIONS.CHANGE_READ,
      PERMISSIONS.CHANGE_REQUEST,
      PERMISSIONS.CHANGE_APPROVE,

      PERMISSIONS.STORES_READ,
      PERMISSIONS.SAMPLING_REQUEST,
      PERMISSIONS.SPEC_READ,
      PERMISSIONS.SPEC_MANAGE,
      PERMISSIONS.SPEC_APPROVE,
      PERMISSIONS.BATCH_DISPOSITION,
      PERMISSIONS.OOS_MANAGE,
      PERMISSIONS.COA_ISSUE,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SAMPLE_READ,
      PERMISSIONS.RESULT_READ,
      // Authorises the analytical result before dispositioning the batch on it.
      PERMISSIONS.RESULT_VERIFY,
      PERMISSIONS.RESULT_AUTHORIZE,
      PERMISSIONS.RESULT_AMEND,
      PERMISSIONS.RESULT_CALLBACK,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.REPORT_GENERATE,
      PERMISSIONS.REPORT_RELEASE,
      PERMISSIONS.CATALOG_READ,
      PERMISSIONS.QC_READ,
      PERMISSIONS.QC_OVERRIDE,
      PERMISSIONS.QC_MANAGE,
      PERMISSIONS.DEVICE_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.COMPETENCY_MANAGE,
      PERMISSIONS.USER_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.AUDIT_VERIFY,
      PERMISSIONS.COMPLIANCE_EXPORT,
      // Deliberately absent: RESULT_ENTER. QA must not be able to generate the
      // number it then releases.
    ],
  },

  AUDITOR: {
    name: 'Auditor',
    description: 'Read-only access including the full audit trail. Changes nothing.',
    permissions: [
      PERMISSIONS.PQR_READ,

      PERMISSIONS.EM_READ,

      PERMISSIONS.STABILITY_READ,

      PERMISSIONS.DEVIATION_READ,
      PERMISSIONS.CAPA_READ,
      PERMISSIONS.CHANGE_READ,

      PERMISSIONS.PATIENT_READ,
      PERMISSIONS.ORDER_READ,
      PERMISSIONS.SAMPLE_READ,
      PERMISSIONS.RESULT_READ,
      PERMISSIONS.REPORT_READ,
      PERMISSIONS.CATALOG_READ,
      PERMISSIONS.QC_READ,
      PERMISSIONS.DEVICE_READ,
      PERMISSIONS.INVOICE_READ,
      PERMISSIONS.USER_READ,
      PERMISSIONS.INVENTORY_READ,
      PERMISSIONS.ANALYTICS_READ,
      PERMISSIONS.STORES_READ,
      PERMISSIONS.SPEC_READ,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.AUDIT_VERIFY,
      PERMISSIONS.COMPLIANCE_EXPORT,
    ],
  },
};

/**
 * Which roles a tenant is provisioned with depends on the vertical it runs.
 *
 * Roles are per-tenant rows, so this is a provisioning decision, not a runtime
 * filter: a pharma manufacturing site has no phlebotomist and bills no patient,
 * and offering those in the "add a user" dropdown is how a demo loses a room.
 * The templates all remain defined — a diagnostics tenant still gets its own —
 * but a pharma tenant is only ever given the five that mean something on a
 * shop floor.
 */
export const PHARMA_ROLE_CODES = [
  'LAB_ADMIN',
  'QA',
  'QC_ANALYST',
  'STORES',
  'AUDITOR',
] as const;

export const DIAGNOSTICS_ROLE_CODES = [
  'LAB_ADMIN',
  'PATHOLOGIST',
  'LAB_TECHNICIAN',
  'PHLEBOTOMIST',
  'RECEPTIONIST',
  'ACCOUNTANT',
  'AUDITOR',
] as const;

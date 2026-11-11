// Copyright 2026 The Steward Authors
// SPDX-License-Identifier: Apache-2.0
// The prose of the docs start state's documents: policies, procedures and appendices of a fictional organisation.

/* oxlint-disable unicorn-js/prevent-abbreviations -- the file name is fixed by the docs data set */

import {
  appendixText,
  buttonCard,
  calloutCard,
  dividerCard,
  fileCard,
  imageCard,
  list,
  rich,
  SEEDED_FILE_IDS,
  toggleCard,
} from "#product/data/extras.ts";
import { document, h1, h2, p, table } from "#product/data/policies.ts";

const expensePurpose = [
  h1("Purpose"),
  p(
    "This policy explains how Example Organisation reimburses money that staff spend on its behalf. It exists so that claims are handled fairly, quickly and in line with the organisation's financial controls.",
  ),
];

const expenseScope = [
  h1("Scope"),
  p(
    "This policy applies to all employees, contractors and board members who incur costs while working for Example Organisation, in any country where it operates.",
  ),
];

const expenseLimitsV2 = table(
  ["Expense type", "Limit", "Evidence needed"],
  ["Meals while travelling", "35 per day", "Itemised receipt"],
  ["Hotel (per night)", "160", "Hotel invoice"],
  ["Local transport", "Actual cost", "Receipt or ticket"],
  ["Client entertainment", "60 per head", "Receipt and list of guests"],
);

const expenseLimitsV3 = table(
  ["Expense type", "Limit", "Evidence needed"],
  ["Meals while travelling", "40 per day", "Itemised receipt"],
  ["Hotel (per night)", "175", "Hotel invoice"],
  ["Local transport", "Actual cost", "Receipt or ticket"],
  ["Client entertainment", "60 per head", "Receipt and list of guests"],
);

const expenseResponsibilities = [
  h1("Responsibilities"),
  list(
    "bullet",
    "Employees submit accurate claims and keep the original receipts for 12 months.",
    "Line managers approve or return claims within 5 working days.",
    "The finance team checks claims against this policy and pays approved claims in the next payment run.",
  ),
];

const expenseExceptions = [
  h1("Exceptions"),
  p(
    "The Finance Director may approve spending above a limit in advance and in writing. Approvals given after the cost has been incurred are granted only where an emergency made prior approval impossible.",
  ),
];

const expenseRules = [
  "Claim only costs that were necessary and reasonable for the business purpose.",
  "Submit every claim with a receipt or other proof of payment.",
  "Do not claim for personal items, fines or alcohol bought outside a client event.",
];

const expenseV1 = document(
  ...expensePurpose,
  ...expenseScope,
  h1("Policy statement"),
  p(
    "Staff may claim reasonable, necessary and receipted costs that they paid personally for business purposes. Claims are submitted within 60 days of the expense and are approved by the claimant's line manager before payment.",
  ),
);

const expenseV2 = document(
  ...expensePurpose,
  ...expenseScope,
  h1("Policy statement"),
  p(
    "Staff may claim reasonable, necessary and receipted costs that they paid personally for business purposes. Claims are submitted within 60 days of the expense and are approved by the claimant's line manager before payment.",
  ),
  list("bullet", ...expenseRules),
  p("The limits in the table below apply to each claimant."),
  expenseLimitsV2,
  ...expenseResponsibilities,
);

const expenseV3Statement = [
  h1("Policy statement"),
  p(
    "Staff may claim reasonable, necessary and receipted costs that they paid personally for business purposes. Claims are submitted within 60 days of the expense and are approved by the claimant's line manager before payment.",
  ),
  list(
    "bullet",
    ...expenseRules,
    "Book flights and hotels through the approved booking portal wherever possible.",
  ),
  p("The limits in the table below apply to each claimant."),
  expenseLimitsV3,
];

const expenseV3 = document(
  ...expensePurpose,
  ...expenseScope,
  ...expenseV3Statement,
  ...expenseResponsibilities,
  ...expenseExceptions,
);

const expenseRevision = document(
  ...expensePurpose,
  ...expenseScope,
  h1("Policy statement"),
  p(
    "Staff may claim reasonable, necessary and receipted costs that they paid personally for business purposes. Claims are submitted within 30 days of the expense and are approved by the claimant's line manager before payment.",
  ),
  list(
    "bullet",
    ...expenseRules,
    "Book flights and hotels through the approved booking portal wherever possible.",
    "Use a corporate card for travel and accommodation where one has been issued, and do not claim those costs again as expenses.",
  ),
  p("The limits in the table below apply to each claimant."),
  expenseLimitsV3,
  ...expenseResponsibilities,
  ...expenseExceptions,
);

const mileageV1 = table(
  ["Item", "Rate", "Unit"],
  ["Car mileage (first 10,000 miles)", "0.45", "per mile"],
  ["Car mileage (after 10,000 miles)", "0.25", "per mile"],
  ["Motorcycle", "0.24", "per mile"],
  ["Bicycle", "0.20", "per mile"],
);

const mileageV2 = table(
  ["Item", "Rate", "Unit"],
  ["Car mileage (first 10,000 miles)", "0.47", "per mile"],
  ["Car mileage (after 10,000 miles)", "0.25", "per mile"],
  ["Motorcycle", "0.26", "per mile"],
  ["Bicycle", "0.20", "per mile"],
  ["Overnight stay with friends or family", "25", "per night"],
);

const mileageDraft = table(
  ["Item", "Rate", "Unit"],
  ["Car mileage (first 10,000 miles)", "0.47", "per mile"],
  ["Car mileage (after 10,000 miles)", "0.27", "per mile"],
  ["Motorcycle", "0.26", "per mile"],
  ["Bicycle", "0.20", "per mile"],
  ["Overnight stay with friends or family", "25", "per night"],
);

const mileageIntro = p(
  "Rates are paid in the currency of the country where the claimant is employed and apply to journeys made for business purposes only. Commuting is not claimable.",
);

export const expenseClaims = {
  revision: expenseRevision,
  v1: expenseV1,
  v2: expenseV2,
  v3: expenseV3,
};

export const expenseAppendixA = {
  draft: appendixText(
    "Appendix A",
    mileageIntro,
    mileageDraft,
    p(
      "Note: the rates in this table are proposed and take effect only when this appendix is published. Claimants should keep a log of the start and end point of each journey.",
    ),
  ),
  v1: appendixText("Appendix A", mileageIntro, mileageV1),
  v2: appendixText("Appendix A", mileageIntro, mileageV2),
};

export const expenseAppendixB = appendixText(
  "Appendix B",
  p("Check each item before you submit a claim."),
  list(
    "number",
    "The expense is for a business purpose and is covered by the policy.",
    "You have an itemised receipt for every item over 10.",
    "The receipt shows the date, supplier and amount paid.",
    "You have converted foreign currency using the rate on the date of payment.",
    "You have attached approval for any spending above a limit.",
    "You have selected the correct cost centre and your line manager.",
  ),
);

export const expenseAppendixC = appendixText(
  "Appendix C",
  p(
    "These rates were in force during 2025. They no longer apply and are kept for reference when checking older claims.",
  ),
  table(
    ["Item", "2025 rate", "Unit"],
    ["Car mileage (first 10,000 miles)", "0.45", "per mile"],
    ["Meals while travelling", "35", "per day"],
    ["Hotel (per night)", "160", "per night"],
  ),
);

export const recordsRetention = document(
  h1("Purpose"),
  p(
    "This policy sets how long Example Organisation keeps its records and how they are destroyed afterwards. Keeping records for too short a time exposes the organisation to legal risk, and keeping them for too long increases the harm of a data breach.",
  ),
  h1("Scope"),
  p(
    "This policy covers every record created or received by the organisation in any format, including paper, email, databases, logs and backups. It applies to all staff, contractors and suppliers who hold records on the organisation's behalf.",
  ),
  h1("Policy statement"),
  p(
    "Each record type has a retention period, which is the minimum time the record must be kept before it can be destroyed. The retention period starts on the date the record is closed or last used, not the date it was created.",
  ),
  table(
    ["Record type", "Retention period", "Owner"],
    ["Finance records", "7 years", "Finance team"],
    ["HR personnel files", "6 years after leaving", "HR team"],
    ["Access logs", "12 months", "IT team"],
    ["Visitor logs", "12 months", "Facilities team"],
    ["Incident reports", "5 years", "Privacy Officer"],
  ),
  h2("Legal hold"),
  p(
    "When the Legal team issues a legal hold, the retention period for the affected records is suspended and they must not be changed or destroyed until the hold is lifted in writing. A legal hold overrides every other rule in this policy.",
  ),
  h2("Disposal"),
  list(
    "bullet",
    "Paper records are shredded or placed in the secure disposal bins.",
    "Electronic records are deleted from live systems within 30 days of the end of the retention period, and from backups at their next scheduled rotation.",
    "Disposal of records over five years old is logged by the record owner.",
  ),
  h1("Responsibilities"),
  p(
    "Record owners keep this schedule accurate and review it every year. The IT team carries out automated deletion, and every employee is responsible for not keeping personal copies of records beyond their retention period.",
  ),
);

export const travelBooking = document(
  h1("Steps"),
  h2("Prepare the request"),
  list(
    "number",
    "Confirm that your line manager has approved the trip and note the cost centre.",
    "Sign in to the approved booking portal with your work account.",
  ),
  imageCard(SEEDED_FILE_IDS.image, "Booking portal home screen"),
  h2("Book the trip"),
  list(
    "number",
    "Search for flights, trains and hotels using your travel dates. Book at least 14 days ahead where you can.",
    "Choose the lowest logical fare within the class allowed for the length of the journey.",
    "Add the cost centre and the business reason for the trip.",
    "Submit the booking. The portal sends it to your line manager, who has 2 working days to approve it.",
    "Once approved, the portal issues the tickets and sends the confirmation to your work email.",
  ),
  h1("Afterwards"),
  list(
    "bullet",
    "Keep the booking confirmation and attach it to your expense claim.",
    "Cancel unused bookings in the portal as soon as plans change so that refunds can be recovered.",
    "Report any problem with the portal to the IT service desk at servicedesk@example.org.",
  ),
);

export const visitorAccess = document(
  h1("Purpose"),
  p(
    "This policy protects people, information and property by making sure that everyone who enters an Example Organisation site is known, authorised and accompanied where necessary.",
  ),
  h1("Scope"),
  p(
    "It applies to all visitors, including contractors, delivery staff, auditors and guests, and to every employee who hosts or meets a visitor on organisation premises.",
  ),
  h1("Policy statement"),
  list(
    "bullet",
    "Visitors must be registered in advance by their host and sign in at reception on arrival, showing photographic identification.",
    "Every visitor receives a badge that must be worn and visible at all times and returned at reception on departure.",
    "Visitors are escorted by their host at all times, except in areas shown as open to the public.",
    "Children under 16 may visit only with a responsible adult and with the approval of the Facilities team.",
    "Contractors who work on site for more than 5 days must complete an induction and hold a contractor badge.",
  ),
  table(
    ["Badge colour", "Holder", "Access allowed"],
    [
      "Green",
      "Visitor",
      "Reception, meeting rooms and the canteen with an escort",
    ],
    [
      "Yellow",
      "Contractor",
      "Work areas named on the booking, escort not needed after induction",
    ],
    [
      "Red",
      "Restricted visit",
      "Specific secure areas with an escort and written approval",
    ],
  ),
  h2("Emergency evacuation"),
  p(
    "In an evacuation, hosts are responsible for taking their visitors to the assembly point and confirming to the fire marshal that they are accounted for. Reception keeps the sign-in list and gives it to the marshal.",
  ),
  h1("Responsibilities"),
  p(
    "Hosts are accountable for their visitors' behaviour. The reception team checks identity and badges, and the Facilities team reviews the visitor log every month.",
  ),
);

export const incidentResponse = document(
  h1("Steps"),
  h2("Detect and contain"),
  list(
    "number",
    "Report the suspected incident to the IT service desk straight away. Do not wait to be certain.",
    "The incident coordinator triages the report and assigns a severity level from the table below.",
    "Contain the incident by isolating affected systems, disabling compromised accounts and preserving evidence.",
  ),
  table(
    ["Severity", "Description", "Response time"],
    [
      "Critical",
      "Confirmed loss of personal data or a major service outage",
      "Within 1 hour",
    ],
    ["High", "Likely compromise of an important system", "Within 4 hours"],
    ["Medium", "Contained issue with limited impact", "Within 1 working day"],
    ["Low", "Minor event with no impact", "Within 3 working days"],
  ),
  h2("Escalate and notify"),
  list(
    "number",
    "Escalate to the Privacy Officer immediately if personal data may be involved.",
    "The Privacy Officer decides whether the regulator must be told. Where required, notification is made within 72 hours of becoming aware of the breach.",
    "Inform affected customers and partners without undue delay once the facts are confirmed.",
    "Record every decision and action in the incident log as it happens.",
  ),
  fileCard(
    SEEDED_FILE_IDS.pdf,
    "incident-report-template.pdf",
    18_432,
    "Incident report template",
  ),
  h1("Afterwards"),
  list(
    "bullet",
    "Hold a lessons learned review within 10 working days of closing the incident.",
    "Record the root cause, what worked and what must change, with an owner and date for each action.",
    "Share a summary with the leadership team and update this procedure where needed.",
    "Keep the completed incident report for the period set in the Records Retention Policy.",
  ),
);

export const informationSecurity = document(
  h1("Purpose"),
  p(
    "This policy sets the baseline rules that protect the confidentiality, integrity and availability of Example Organisation's information and systems.",
  ),
  h1("Scope"),
  p(
    "It applies to all employees, contractors and any system that stores or processes organisation information, wherever it is located.",
  ),
  p("Third-party suppliers follow the same rules."),
  h1("Policy statement"),
  list(
    "bullet",
    "Passwords must be at least 12 characters long.",
    "Multi-factor authentication is required for all remote access and for administrator accounts.",
    "Laptops are encrypted by the IT team.",
    "Access reviews happen every year.",
    "Security patches for critical vulnerabilities are applied within 14 days of release.",
    "Security incidents are reported to the IT service desk straight away.",
  ),
  h1("Responsibilities"),
  table(
    ["Role", "Responsibility"],
    [
      "Chief Information Security Officer",
      "Owns this policy and reports on compliance each quarter",
    ],
    ["IT team", "Operates controls, patching and encryption"],
    [
      "Line managers",
      "Confirm that their staff have only the access they need",
    ],
    ["All staff", "Follow this policy and report concerns"],
  ),
  h1("Exceptions"),
  p(
    "Exceptions must be requested in writing, justified by a risk assessment and approved by the Chief Information Security Officer. Each exception expires after 6 months unless it is renewed.",
  ),
);

const acceptablePurpose = [
  h1("Purpose"),
  p(
    "This policy sets out how staff may use Example Organisation's computers, networks, email and accounts, so that they remain secure, lawful and available for work.",
  ),
];

const acceptableScope = [
  h1("Scope"),
  p(
    "It applies to everyone who uses organisation equipment or accounts, including employees, contractors and temporary staff, on site or elsewhere.",
  ),
];

export const acceptableUse = {
  current: document(
    ...acceptablePurpose,
    ...acceptableScope,
    h1("Policy statement"),
    list(
      "bullet",
      "Use organisation systems mainly for work. Limited personal use is allowed if it does not affect your work or security.",
      "Do not share your credentials or let anyone else use your account.",
      "Do not install software that has not been approved by the IT team.",
      "Do not store organisation information in personal cloud storage or personal email.",
      "Report lost or stolen devices to the IT service desk within one hour.",
    ),
    h1("Responsibilities"),
    p(
      "Users are responsible for the activity on their accounts. Line managers make sure new staff read this policy during their first week. The IT team monitors systems for misuse.",
    ),
    p(
      "Breaches of this policy may lead to disciplinary action and, where the law was broken, to a report to the authorities.",
    ),
  ),
  seen: document(
    ...acceptablePurpose,
    ...acceptableScope,
    h1("Policy statement"),
    list(
      "bullet",
      "Use organisation systems mainly for work. Limited personal use is allowed if it does not affect your work.",
      "Do not share your credentials or let anyone else use your account.",
      "Do not install software that has not been approved by the IT team.",
      "Do not store organisation information in personal cloud storage or personal email.",
    ),
    h1("Responsibilities"),
    p(
      "Users are responsible for the activity on their accounts. Line managers make sure new staff read this policy during their first week. The IT team monitors systems for misuse.",
    ),
  ),
};

export const remoteWorking = document(
  h1("Purpose"),
  p(
    "This policy lets staff work away from the office in a way that is productive, secure and fair, and that protects their health and wellbeing.",
  ),
  h1("Scope"),
  p(
    "It applies to employees whose role can be done remotely and whose line manager has approved a remote or hybrid working arrangement.",
  ),
  h1("Policy statement"),
  h2("Eligibility"),
  p(
    "Staff who have completed their probation period may ask for remote working. Line managers decide within 10 working days, based on the needs of the role and the team.",
  ),
  h2("Working hours"),
  p(
    "Remote workers keep to their contracted hours and are reachable during core hours of 10:00 to 15:00. Breaks and the right to disconnect apply in the same way as in the office.",
  ),
  h2("Security at home"),
  list(
    "bullet",
    "Work only on organisation devices, on a password-protected home network.",
    "Lock your screen when you step away and do not let others in your household use your device.",
    "Keep paper documents to a minimum and shred them securely after use.",
  ),
  h2("Equipment and expenses"),
  table(
    ["Item", "Provided by the organisation"],
    ["Laptop and charger", "Yes"],
    ["Monitor, keyboard and mouse", "Yes, one set"],
    ["Desk and chair", "Allowance of 250, once"],
    ["Internet and electricity", "Monthly allowance of 20"],
  ),
  h1("Responsibilities"),
  p(
    "Employees keep their workspace safe and report accidents. Line managers hold regular one-to-one meetings and review each arrangement every 6 months.",
  ),
);

export const supplierOnboarding = document(
  h1("Steps"),
  list(
    "number",
    "The requester submits a supplier request in the procurement system, with the business reason and the expected annual spend.",
    "Procurement sends the supplier the due diligence questionnaire, which the supplier returns within 10 working days.",
    "The Risk team reviews the answers and gives the supplier a risk rating of low, medium or high.",
    "Legal prepares the contract. High-risk suppliers must accept the security and data protection schedules before signing.",
    "The IT team creates access only after the contract is signed, limited to what the supplier needs.",
    "Procurement adds the supplier to the supplier register with its owner, rating and contract end date.",
  ),
  table(
    ["Risk rating", "Review frequency", "Approval needed"],
    ["Low", "Every 3 years", "Procurement"],
    ["Medium", "Every 2 years", "Head of department"],
    ["High", "Every year", "Chief Information Security Officer"],
  ),
  h1("Afterwards"),
  list(
    "bullet",
    "The supplier owner confirms within 30 days that the supplier is working as agreed.",
    "Procurement reminds the owner 90 days before the contract ends.",
    "Access is removed on the day the contract ends.",
  ),
);

export const giftsAndHospitality = document(
  h1("Steps"),
  rich(
    ["Gifts and hospitality must never be ", 0],
    ["offered or accepted", 1],
    [" in return for a favour, and ", 0],
    ["cash is always refused", 2],
    [".", 0],
  ),
  list(
    "number",
    "Do not accept a gift or hospitality that could appear to influence a decision, or that is offered during a tender.",
    "Decline cash, vouchers and any gift worth more than 100 politely, and tell your line manager.",
    "Declare any other gift or hospitality over 25 in the register within 5 working days.",
    "Your line manager reviews the entry and approves, returns or asks for the gift to be handed back.",
    "The Compliance team checks the register every quarter and reports on trends to the leadership team.",
  ),
  table(
    ["Value", "Action"],
    ["Under 25", "No declaration needed"],
    ["25 to 100", "Declare in the register and obtain approval"],
    ["Over 100", "Decline, or hand to Compliance with a declaration"],
  ),
  h1("Afterwards"),
  list(
    "bullet",
    "Gifts that cannot be declined are given to a charity raffle or kept by the organisation.",
    "Entries in the register are kept for 6 years.",
    "Staff who give gifts on behalf of the organisation must record them in the same register.",
  ),
);

export const supplierManagement = document(
  h1("Purpose"),
  p(
    "This policy sets out how Example Organisation chooses, manages and ends relationships with suppliers, so that the services it buys are reliable, secure and good value.",
  ),
  h1("Scope"),
  p(
    "It covers every supplier that provides goods or services to the organisation, including software, consultancy, cleaning and facilities. It does not cover employment agencies, which have their own policy.",
  ),
  h1("Policy statement"),
  list(
    "bullet",
    "Every supplier is assessed for risk before a contract is signed.",
    "Contracts above 25,000 a year need at least three quotes, unless Procurement agrees otherwise.",
    "Each supplier has a named owner inside the organisation.",
    "Suppliers that handle personal data must sign a data processing agreement.",
    "Critical suppliers are reviewed every year, including their performance and security.",
    "Contracts record how data is returned or deleted when the relationship ends.",
  ),
  h1("Responsibilities"),
  p(
    "Procurement keeps the supplier register and runs reviews. Supplier owners manage day-to-day performance and report problems. The Risk team advises on high-risk suppliers.",
  ),
);

export const clearDesk = document(
  h1("Purpose"),
  p(
    "This policy reduces the risk of confidential information being seen, copied or lost by keeping workspaces clear when nobody is using them. It also helps cleaners and visitors to move around safely.",
  ),
  h1("Scope"),
  p(
    "It applies to all desks, meeting rooms and shared work areas at Example Organisation sites, and to staff who work from home with organisation documents.",
  ),
  h1("Policy statement"),
  p(""),
);

export const dataClassification = document(
  h1("Purpose"),
  p(
    "This policy sets four classes of information so that everyone knows how sensitive a piece of information is and how it must be handled.",
  ),
  h1("Scope"),
  p(
    "It applies to all information held by or for Example Organisation, in any form, and to everyone who creates, receives or shares it.",
  ),
  h1("Policy statement"),
  p(
    "The owner of the information assigns one class when it is created. If information is not labelled, treat it as Internal until the owner says otherwise.",
  ),
  table(
    ["Class", "Meaning", "Handling rules"],
    [
      "Public",
      "Approved for release to anyone",
      "No restrictions on sharing; approval needed to publish",
    ],
    [
      "Internal",
      "For staff and trusted partners",
      "Share only within the organisation; do not post on public sites",
    ],
    [
      "Confidential",
      "Could harm the organisation if disclosed",
      "Share on a need-to-know basis; encrypt in transit and at rest",
    ],
    [
      "Restricted",
      "Serious harm if disclosed, such as personal or financial data",
      "Named recipients only; encrypt, log all access and never send by email",
    ],
  ),
  h1("Responsibilities"),
  list(
    "bullet",
    "Information owners choose the class and review it when the content changes.",
    "All staff label documents and follow the handling rules.",
    "The IT team provides the tools to encrypt and monitor information.",
  ),
);

/** Bob's Editor Tour draft: one of each card the editor guide shows. */
export const editorTour = document(
  h1("Purpose"),
  p(
    "This draft exists to try the editor. It holds one of each block the editor adds from the + button and the / menu.",
  ),
  calloutCard(
    "Keep this draft while you learn the editor. Nothing in it is a real policy.",
  ),
  h1("Scope"),
  p("It applies to anyone who wants to see what each block looks like."),
  toggleCard(
    "Why are there so many blocks?",
    "Each block suits a different kind of content: a note, an answer that stays out of the way, a link that looks like a button.",
  ),
  buttonCard("Read the editor guide", "https://example.org/editor-guide"),
  dividerCard(),
  h1("Policy statement"),
  p("Use a block when plain text would not be as clear."),
  imageCard(
    SEEDED_FILE_IDS.image,
    "A screenshot of the booking portal home page",
    "The booking portal home page",
  ),
  fileCard(
    SEEDED_FILE_IDS.pdf,
    "editor-tour-checklist.pdf",
    18_432,
    "Editor tour checklist",
  ),
);

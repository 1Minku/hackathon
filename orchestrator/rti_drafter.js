/**
 * RTI Drafter — generates a structured, evidence-specific Right to Information
 * query based on the anomalies found by the TenderWatch orchestrator.
 *
 * RTI Act 2005 (Section 6): Any Indian citizen can file a query to any public
 * authority demanding information about their activities.
 */

const RTI_OFFICE_MAPPING = {
  'Public Works Department': 'The State Public Information Officer (SPIO), Public Works Department',
  'Education Department': 'The State Public Information Officer (SPIO), Education Department',
  'Health Department': 'The State Public Information Officer (SPIO), Health & Family Welfare Department',
  'District Administration': 'The District Public Information Officer (DPIO), Office of the District Collector',
  'Transport Department': 'The State Public Information Officer (SPIO), Transport Department',
  'Energy Department': 'The State Public Information Officer (SPIO), Energy / Power Department',
  'Jal Jeevan Mission': 'The State Public Information Officer (SPIO), Department of Water Resources / Jal Jeevan Mission Nodal Office',
  'PMGSY': 'The State Public Information Officer (SPIO), PMGSY State Nodal Agency (SRRDA)',
  'Irrigation Department': 'The State Public Information Officer (SPIO), Water Resources / Irrigation Department',
  'Housing Department': 'The State Public Information Officer (SPIO), Housing & Urban Development Department',
  'Power Department': 'The State Public Information Officer (SPIO), Energy / Power Department',
  'General Administration': 'The State Public Information Officer (SPIO), General Administration Department',
};

const TODAY = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

/**
 * Generate anomaly-specific questions based on which tools flagged issues
 */
function generateSpecificQuestions(tender, findings) {
  const questions = [];
  let qNum = 1;

  // Always include basic tender information request
  questions.push(`${qNum++}. Please provide certified copies of all tender documents for Tender ID ${tender.tender_id}, including: Notice Inviting Tender (NIT), tender specifications, evaluation criteria, comparative statement of bids, and the final award order.`);

  const priceFinding = findings?.find(f => f.tool === 'check_price_anomaly' && f.flag);
  const vendorFinding = findings?.find(f => f.tool === 'check_vendor_history' && f.flag);
  const bidderFinding = findings?.find(f => f.tool === 'check_bidder_relationship' && f.flag);

  if (priceFinding) {
    questions.push(`${qNum++}. The price quoted in Tender ${tender.tender_id} (₹${tender.quoted_price.toLocaleString('en-IN')} ${tender.unit}) appears to deviate significantly from prevailing market rates. Please provide: (a) the basis on which this rate was approved, (b) the rate analysis document or market rate survey conducted prior to tender publication, and (c) the approval of the competent financial authority for rates exceeding the Schedule of Rates.`);

    questions.push(`${qNum++}. Was a price reasonableness check conducted before award? If yes, provide the supporting documents and the officer who certified the rates as reasonable. If no, please state the reason why it was not conducted.`);
  }

  if (vendorFinding) {
    questions.push(`${qNum++}. Please provide a list of ALL tenders awarded to "${tender.vendor}" by ${tender.department} in the past three (3) financial years, including tender IDs, award dates, values, and procurement categories.`);

    questions.push(`${qNum++}. What measures were taken to ensure open and transparent competition in Tender ${tender.tender_id}? Please provide evidence of tender publication on CPPP/GeM portals, newspapers, and any pre-bid meetings held.`);
  }

  if (bidderFinding) {
    questions.push(`${qNum++}. For Tender ${tender.tender_id}, please provide the complete list of all bidders who submitted bids, including their registered addresses, GST numbers, and contact details as verified by the department.`);

    questions.push(`${qNum++}. Did the department conduct address verification or background checks on the participating bidders before accepting their bids? Please provide the verification records. Specifically, were any two or more bidders found to share the same registered address or directors?`);

    questions.push(`${qNum++}. If any bidders were found to have overlapping addresses or common directors, what action was taken under the Prevention of Corruption Act and the Competition Act? Was the matter referred to the Competition Commission of India (CCI)?`);
  }

  if (tender.bidder_count === 1) {
    questions.push(`${qNum++}. Tender ${tender.tender_id} appears to have received only a single bid. (a) Was a second call for tenders issued, and if not, the reasons therefor? (b) What was the outcome of any relaxation of eligibility criteria to attract more bidders? (c) Was single-tender approval obtained from the competent authority, and please provide a copy of such approval.`);
  }

  // Standard transparency question
  questions.push(`${qNum++}. Please provide the details of the public officer responsible for the tendering process and subsequent approval at each stage, along with their designation and employee ID.`);

  return questions;
}

/**
 * Main RTI drafting function
 */
export function draftRtiQuery(tender, findings, reasoning) {
  const rti_to = RTI_OFFICE_MAPPING[tender.department] || `The State Public Information Officer (SPIO), ${tender.department}`;
  const questions = generateSpecificQuestions(tender, findings);

  const anomalySummary = [];
  const priceFinding = findings?.find(f => f.tool === 'check_price_anomaly' && f.flag);
  const vendorFinding = findings?.find(f => f.tool === 'check_vendor_history' && f.flag);
  const bidderFinding = findings?.find(f => f.tool === 'check_bidder_relationship' && f.flag);

  if (priceFinding) anomalySummary.push(`pricing irregularity (${priceFinding.key_metric || 'price significantly above market rate'})`);
  if (vendorFinding) anomalySummary.push(`vendor award concentration (${vendorFinding.key_metric || 'high concentration ratio'})`);
  if (bidderFinding) anomalySummary.push(`potential bid-rigging indicators (${bidderFinding.key_metric || 'bidder address/director overlap'})`);
  if (tender.bidder_count === 1) anomalySummary.push('single-bidder award');

  const anomalyDescription = anomalySummary.length > 0
    ? anomalySummary.join(', ')
    : 'statistical anomalies in procurement pricing and vendor selection';

  return {
    header: {
      to: rti_to,
      subject: `RTI Application under Section 6 of the Right to Information Act, 2005 — Regarding Tender ID: ${tender.tender_id}`,
      date: TODAY,
      reference_tender: tender.tender_id,
      department: tender.department,
      state: tender.state
    },
    body: `To,
${rti_to},
${tender.department},
Government of ${tender.state}

Subject: Request for Information under Section 6(1) of the Right to Information Act, 2005 — Tender ID: ${tender.tender_id} ("${tender.title}")

Date: ${TODAY}

Sir/Madam,

I, the undersigned, a citizen of India, hereby submit this application under Section 6(1) of the Right to Information Act, 2005, to obtain information regarding the above-referenced government tender.

**Background:**
Tender ID ${tender.tender_id} was issued by ${tender.department}, Government of ${tender.state} for "${tender.title}" (Category: ${tender.category}) and awarded to M/s ${tender.vendor} on ${tender.award_date}, with a quoted price of ₹${tender.quoted_price.toLocaleString('en-IN')} ${tender.unit} for a quantity of ${tender.quantity} units, amounting to a total tender value of ₹${tender.tender_value.toLocaleString('en-IN')}.

A review of publicly available procurement data reveals statistical patterns warranting administrative clarification, including ${anomalyDescription}. This application seeks information to enable informed public scrutiny and is submitted in the interest of transparency and accountability in public spending.

**Information Requested:**

${questions.join('\n\n')}

**Note:** All information requested above is in relation to the exercise of public functions and expenditure of public funds, and is accordingly not exempt under any provision of Section 8 of the RTI Act, 2005.

I am enclosing the prescribed application fee of ₹10/- (Rs. Ten) by Indian Postal Order / Demand Draft / Court Fee Stamp.

I request you to provide the above information within 30 days as mandated under Section 7(1) of the RTI Act, 2005.

Yours faithfully,
[Applicant Name]
[Address]
[Phone Number]
[Date: ${TODAY}]

---
*This RTI query was generated by TenderWatch on the basis of statistical analysis of public tender data. It represents a request for administrative clarification, not an allegation of wrongdoing. All findings are statistical patterns that may have legitimate explanations.*`,
    questions,
    anomaly_basis: anomalySummary,
    agent_reasoning: reasoning,
    generated_at: new Date().toISOString()
  };
}

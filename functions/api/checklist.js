/**
 * Document Checklist Generator API
 * Returns visa-type specific document checklists with embassy/country rules
 */

// Base document requirements by visa type
const VISA_DOCUMENTS = {
  'study': {
    mandatory: [
      { id: 'passport', name: 'Valid Passport', description: 'Must be valid for at least 6 months beyond intended stay', category: 'identity' },
      { id: 'letter_of_acceptance', name: 'Letter of Acceptance', description: 'From recognized Irish institution, full-time course', category: 'academic' },
      { id: 'proof_of_fees', name: 'Proof of Fees Paid', description: 'Receipt or bank statement showing tuition payment', category: 'financial' },
      { id: 'proof_of_funds', name: 'Proof of Funds (€7,000)', description: 'Bank statements showing €7,000 for living expenses per year', category: 'financial' },
      { id: 'medical_insurance', name: 'Medical Insurance', description: 'Private medical insurance valid in Ireland', category: 'health' },
      { id: 'english_proof', name: 'English Language Proof', description: 'IELTS 5.0+ or equivalent (if required by institution)', category: 'academic' },
      { id: 'previous_qualifications', name: 'Previous Qualifications', description: 'Certified copies of degrees/diplomas', category: 'academic' },
      { id: 'application_form', name: 'Visa Application Form', description: 'Completed online via AVATS', category: 'form' },
      { id: 'photos', name: 'Passport Photos', description: '2 recent passport-sized photos (35x45mm)', category: 'identity' },
      { id: 'fee_payment', name: 'Visa Fee Payment', description: '€60 single entry / €100 multi-entry', category: 'form' }
    ],
    conditional: [
      { id: 'parental_consent', name: 'Parental Consent', description: 'Required if under 18', category: 'legal', condition: 'age < 18' },
      { id: 'garda_clearance', name: 'Garda Clearance', description: 'Police certificate if studying >12 months', category: 'legal', condition: 'duration > 12 months' },
      { id: 'tb_test', name: 'TB Test Certificate', description: 'Required for certain countries (check INIS list)', category: 'health', condition: 'country_in_tb_list' }
    ]
  },
  'work': {
    mandatory: [
      { id: 'passport', name: 'Valid Passport', description: 'Must be valid for at least 6 months beyond intended stay', category: 'identity' },
      { id: 'employment_permit', name: 'Employment Permit', description: 'Valid Irish employment permit (General/Critical Skills/Intra-company)', category: 'employment' },
      { id: 'job_offer', name: 'Job Offer Letter', description: 'From Irish employer with salary, role, duration', category: 'employment' },
      { id: 'contract', name: 'Employment Contract', description: 'Signed contract with terms and conditions', category: 'employment' },
      { id: 'qualifications', name: 'Relevant Qualifications', description: 'Degrees/certificates relevant to role', category: 'employment' },
      { id: 'medical_insurance', name: 'Medical Insurance', description: 'Private medical insurance valid in Ireland', category: 'health' },
      { id: 'application_form', name: 'Visa Application Form', description: 'Completed online via AVATS', category: 'form' },
      { id: 'photos', name: 'Passport Photos', description: '2 recent passport-sized photos (35x45mm)', category: 'identity' },
      { id: 'fee_payment', name: 'Visa Fee Payment', description: '€60 single entry / €100 multi-entry', category: 'form' }
    ],
    conditional: [
      { id: 'salary_threshold', name: 'Salary Threshold Proof', description: 'Critical Skills: €38,000+; General: €30,000+', category: 'financial', condition: 'permit_type == critical_skills || permit_type == general' },
      { id: 'registration_cert', name: 'Professional Registration', description: 'If role requires professional registration (e.g., nurses, doctors)', category: 'employment', condition: 'regulated_profession' },
      { id: 'p60', name: 'Previous Employment Proof', description: 'P60s or references for previous 5 years', category: 'employment', condition: 'first_time_applicant' }
    ]
  },
  'visit': {
    mandatory: [
      { id: 'passport', name: 'Valid Passport', description: 'Must be valid for at least 6 months beyond intended stay', category: 'identity' },
      { id: 'application_form', name: 'Visa Application Form', description: 'Completed online via AVATS', category: 'form' },
      { id: 'photos', name: 'Passport Photos', description: '2 recent passport-sized photos (35x45mm)', category: 'identity' },
      { id: 'travel_insurance', name: 'Travel Insurance', description: 'Medical insurance covering €30,000 minimum', category: 'health' },
      { id: 'accommodation', name: 'Accommodation Proof', description: 'Hotel booking or invitation letter with address', category: 'travel' },
      { id: 'return_ticket', name: 'Return Ticket', description: 'Confirmed return flight booking', category: 'travel' },
      { id: 'funds_proof', name: 'Proof of Funds', description: 'Bank statements (€65/day of stay minimum)', category: 'financial' },
      { id: 'fee_payment', name: 'Visa Fee Payment', description: '€60 single entry / €100 multi-entry', category: 'form' }
    ],
    conditional: [
      { id: 'invitation_letter', name: 'Invitation Letter', description: 'If visiting friends/family - with host details', category: 'travel', condition: 'purpose == family_friends' },
      { id: 'business_letter', name: 'Business Invitation', description: 'From Irish company with meeting details', category: 'travel', condition: 'purpose == business' },
      { id: 'medical_docs', name: 'Medical Documents', description: 'If seeking medical treatment in Ireland', category: 'health', condition: 'purpose == medical' },
      { id: 'parental_consent', name: 'Parental Consent', description: 'Required if under 18', category: 'legal', condition: 'age < 18' }
    ]
  },
  'family': {
    mandatory: [
      { id: 'passport', name: 'Valid Passport', description: 'Must be valid for at least 6 months beyond intended stay', category: 'identity' },
      { id: 'application_form', name: 'Visa Application Form', description: 'Completed online via AVATS', category: 'form' },
      { id: 'photos', name: 'Passport Photos', description: '2 recent passport-sized photos (35x45mm)', category: 'identity' },
      { id: 'relationship_proof', name: 'Relationship Proof', description: 'Marriage cert, birth cert, civil partnership cert', category: 'family' },
      { id: 'sponsor_docs', name: 'Sponsor Documents', description: 'Irish sponsor\'s passport, residence permit, P60', category: 'financial' },
      { id: 'accommodation_proof', name: 'Accommodation Proof', description: 'Property deeds/rental agreement for sponsor', category: 'travel' },
      { id: 'medical_insurance', name: 'Medical Insurance', description: 'Private medical insurance valid in Ireland', category: 'health' },
      { id: 'fee_payment', name: 'Visa Fee Payment', description: '€60 single entry / €100 multi-entry', category: 'form' }
    ],
    conditional: [
      { id: 'dependency_proof', name: 'Dependency Proof', description: 'For dependent children/parents - financial dependency evidence', category: 'family', condition: 'dependent_applicant' },
      { id: 'guardianship', name: 'Guardianship Docs', description: 'If child traveling without both parents', category: 'legal', condition: 'child_without_both_parents' }
    ]
  },
  'transit': {
    mandatory: [
      { id: 'passport', name: 'Valid Passport', description: 'Must be valid for at least 6 months beyond intended stay', category: 'identity' },
      { id: 'application_form', name: 'Visa Application Form', description: 'Completed online via AVATS', category: 'form' },
      { id: 'photos', name: 'Passport Photos', description: '2 recent passport-sized photos (35x45mm)', category: 'identity' },
      { id: 'onward_ticket', name: 'Onward Ticket', description: 'Confirmed onward flight to final destination', category: 'travel' },
      { id: 'destination_visa', name: 'Destination Visa', description: 'Valid visa for final destination (if required)', category: 'travel' },
      { id: 'fee_payment', name: 'Visa Fee Payment', description: '€25 transit visa', category: 'form' }
    ],
    conditional: [
      { id: 'airside_only', name: 'Airside Transit Proof', description: 'If not leaving airport transit area', category: 'travel', condition: 'airside_transit' }
    ]
  },
  'research': {
    mandatory: [
      { id: 'passport', name: 'Valid Passport', description: 'Must be valid for at least 6 months beyond intended stay', category: 'identity' },
      { id: 'hosting_agreement', name: 'Hosting Agreement', description: 'From Irish research institution (HRB/IRC approved)', category: 'academic' },
      { id: 'qualifications', name: 'PhD/Research Qualifications', description: 'Certified copies of degrees', category: 'academic' },
      { id: 'funding_proof', name: 'Funding Proof', description: 'Grant letter or salary confirmation', category: 'financial' },
      { id: 'medical_insurance', name: 'Medical Insurance', description: 'Private medical insurance valid in Ireland', category: 'health' },
      { id: 'application_form', name: 'Visa Application Form', description: 'Completed online via AVATS', category: 'form' },
      { id: 'photos', name: 'Passport Photos', description: '2 recent passport-sized photos (35x45mm)', category: 'identity' },
      { id: 'fee_payment', name: 'Visa Fee Payment', description: '€60 single entry / €100 multi-entry', category: 'form' }
    ],
    conditional: []
  }
};

// Embassy-specific additional requirements
const EMBASSY_RULES = {
  'new-delhi': {
    additional: [
      { id: 'vcfs_appointment', name: 'VFS Appointment', description: 'Book via VFS Global website', category: 'process' },
      { id: 'biometrics', name: 'Biometrics Appointment', description: 'Required at VFS center', category: 'process' },
      { id: 'police_clearance', name: 'Police Clearance Certificate', description: 'From all states lived in past 5 years', category: 'legal' },
      { id: 'income_tax', name: 'Income Tax Returns', description: 'Last 3 years ITR acknowledgment', category: 'financial' }
    ],
    processing_time: '15-25 working days',
    visa_fee: { single: 60, multi: 100, currency: 'EUR' }
  },
  'beijing': {
    additional: [
      { id: 'vcfs_appointment', name: 'VFS Appointment', description: 'Book via VFS Global website', category: 'process' },
      { id: 'biometrics', name: 'Biometrics Appointment', description: 'Required at VFS center', category: 'process' },
      { id: 'hukou', name: 'Hukou Copy', description: 'Household registration book copy', category: 'identity' },
      { id: 'employment_cert', name: 'Employment Certificate', description: 'From current employer with stamp', category: 'employment' }
    ],
    processing_time: '10-20 working days',
    visa_fee: { single: 60, multi: 100, currency: 'EUR' }
  },
  'dublin': {
    additional: [
      { id: 'in_person', name: 'In-Person Submission', description: 'Submit at INIS office, 13-14 Burgh Quay', category: 'process' }
    ],
    processing_time: '5-15 working days',
    visa_fee: { single: 60, multi: 100, currency: 'EUR' }
  },
  'abu-dhabi': {
    additional: [
      { id: 'vcfs_appointment', name: 'VFS Appointment', description: 'Book via VFS Global website', category: 'process' },
      { id: 'biometrics', name: 'Biometrics Appointment', description: 'Required at VFS center', category: 'process' },
      { id: 'emirates_id', name: 'Emirates ID Copy', description: 'Valid Emirates ID', category: 'identity' }
    ],
    processing_time: '10-20 working days',
    visa_fee: { single: 60, multi: 100, currency: 'EUR' }
  },
  'abuja': {
    additional: [
      { id: 'vcfs_appointment', name: 'VFS Appointment', description: 'Book via VFS Global website', category: 'process' },
      { id: 'biometrics', name: 'Biometrics Appointment', description: 'Required at VFS center', category: 'process' },
      { id: 'police_clearance', name: 'Police Clearance', description: 'From Nigeria Police Force', category: 'legal' }
    ],
    processing_time: '20-30 working days',
    visa_fee: { single: 60, multi: 100, currency: 'EUR' }
  },
  'ankara': {
    additional: [
      { id: 'vcfs_appointment', name: 'VFS Appointment', description: 'Book via VFS Global website', category: 'process' },
      { id: 'biometrics', name: 'Biometrics Appointment', description: 'Required at VFS center', category: 'process' },
      { id: 'residence_permit', name: 'Turkish Residence Permit', description: 'Valid for at least 6 months', category: 'identity' }
    ],
    processing_time: '15-25 working days',
    visa_fee: { single: 60, multi: 100, currency: 'EUR' }
  }
};

// Country-specific TB test requirements
const TB_TEST_COUNTRIES = [
  'Afghanistan', 'Bangladesh', 'Cambodia', 'China', 'Congo', 'Ethiopia',
  'India', 'Indonesia', 'Kenya', 'Myanmar', 'Nigeria', 'Pakistan',
  'Philippines', 'Somalia', 'South Africa', 'Thailand', 'Vietnam',
  'Zambia', 'Zimbabwe'
];

export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    const body = await request.json();
    const { visa_type, embassy, applicant_profile = {} } = body;
    
    if (!visa_type || !VISA_DOCUMENTS[visa_type]) {
      return new Response(JSON.stringify({ 
        error: 'Invalid visa_type', 
        valid_types: Object.keys(VISA_DOCUMENTS) 
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    
    const embassySlug = embassy || 'new-delhi';
    const visaDocs = VISA_DOCUMENTS[visa_type];
    const embassyRules = EMBASSY_RULES[embassySlug] || EMBASSY_RULES['new-delhi'];
    
    // Build personalized checklist
    const checklist = {
      visa_type,
      embassy: embassySlug,
      generated_at: new Date().toISOString(),
      applicant_profile,
      processing_time: embassyRules.processing_time,
      visa_fee: embassyRules.visa_fee,
      mandatory: visaDocs.mandatory.map(doc => ({
        ...doc,
        status: 'pending',
        category: doc.category
      })),
      conditional: visaDocs.conditional.map(doc => ({
        ...doc,
        status: 'not_applicable',
        category: doc.category,
        applicable: evaluateCondition(doc.condition, applicant_profile)
      })),
      embassy_specific: embassyRules.additional.map(doc => ({
        ...doc,
        status: 'pending',
        category: doc.category
      })),
      summary: {
        total_documents: visaDocs.mandatory.length + embassyRules.additional.length,
        mandatory_count: visaDocs.mandatory.length,
        conditional_count: visaDocs.conditional.length,
        embassy_specific_count: embassyRules.additional.length
      }
    };
    
    // Add TB test if applicable
    if (applicant_profile.nationality && TB_TEST_COUNTRIES.includes(applicant_profile.nationality)) {
      checklist.conditional.push({
        id: 'tb_test',
        name: 'TB Test Certificate',
        description: `Required for ${applicant_profile.nationality} nationals`,
        category: 'health',
        status: 'pending',
        applicable: true
      });
      checklist.summary.conditional_count++;
      checklist.summary.total_documents++;
    }
    
    return new Response(JSON.stringify({ success: true, checklist }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('Checklist generation error:', error);
    return new Response(JSON.stringify({ error: 'Failed to generate checklist' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

function evaluateCondition(condition, profile) {
  if (!condition) return false;
  
  try {
    // Simple condition evaluation
    if (condition.startsWith('age <')) {
      const age = parseInt(condition.match(/age < (\d+)/)[1]);
      return (profile.age || 0) < age;
    }
    if (condition.startsWith('duration >')) {
      const months = parseInt(condition.match(/duration > (\d+)/)[1]);
      return (profile.duration_months || 0) > months;
    }
    if (condition === 'country_in_tb_list') {
      return profile.nationality && TB_TEST_COUNTRIES.includes(profile.nationality);
    }
    if (condition === 'purpose == family_friends') {
      return profile.purpose === 'family_friends';
    }
    if (condition === 'purpose == business') {
      return profile.purpose === 'business';
    }
    if (condition === 'purpose == medical') {
      return profile.purpose === 'medical';
    }
    if (condition === 'permit_type == critical_skills || permit_type == general') {
      return profile.permit_type === 'critical_skills' || profile.permit_type === 'general';
    }
    if (condition === 'regulated_profession') {
      return profile.regulated_profession === true;
    }
    if (condition === 'first_time_applicant') {
      return profile.first_time_applicant === true;
    }
    if (condition === 'dependent_applicant') {
      return profile.dependent_applicant === true;
    }
    if (condition === 'child_without_both_parents') {
      return profile.child_without_both_parents === true;
    }
    if (condition === 'airside_transit') {
      return profile.airside_transit === true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function onRequestGet(context) {
  return new Response(JSON.stringify({
    visa_types: Object.keys(VISA_DOCUMENTS).map(vt => ({
      type: vt,
      mandatory_count: VISA_DOCUMENTS[vt].mandatory.length,
      conditional_count: VISA_DOCUMENTS[vt].conditional.length
    })),
    embassies: Object.keys(EMBASSY_RULES).map(e => ({
      slug: e,
      name: e.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      processing_time: EMBASSY_RULES[e].processing_time
    })),
    endpoints: {
      generate: 'POST /api/checklist',
      info: 'GET /api/checklist'
    }
  }), { headers: { 'Content-Type': 'application/json' } });
}

export const onRequest = { POST: onRequestPost, GET: onRequestGet };
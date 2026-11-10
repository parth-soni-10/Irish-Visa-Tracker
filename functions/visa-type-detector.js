/**
 * Visa Type Detection Heuristic
 * Automatically detects visa type from application number patterns and other signals
 */

// Application number ranges by visa type (heuristic based on Irish visa patterns)
// These are approximate ranges observed in the data

export const VISA_TYPE_RANGES = {
  // Study visas (Stamp 2, 2A) - typically higher ranges
  study: [
    { min: 80000000, max: 89999999, confidence: 0.7, subtype: 'Stamp 2/2A' },
    { min: 90000000, max: 99999999, confidence: 0.6, subtype: 'Stamp 2/2A' }
  ],
  
  // Work visas (Stamp 1, 1G, 1H, 4) - mid ranges
  work: [
    { min: 50000000, max: 69999999, confidence: 0.6, subtype: 'Stamp 1/1G/4' },
    { min: 70000000, max: 79999999, confidence: 0.5, subtype: 'Stamp 1/1H' }
  ],
  
  // Visit/Tourist visas (Short stay 'C') - lower ranges
  visit: [
    { min: 10000000, max: 29999999, confidence: 0.7, subtype: 'Short Stay C' },
    { min: 30000000, max: 49999999, confidence: 0.6, subtype: 'Short Stay C' }
  ],
  
  // Family/Join visas (Stamp 3, 4) - various
  family: [
    { min: 40000000, max: 59999999, confidence: 0.5, subtype: 'Stamp 3/4' }
  ],
  
  // Transit visas - specific ranges
  transit: [
    { min: 1000000, max: 9999999, confidence: 0.8, subtype: 'Transit' }
  ],
  
  // Research/Scientific - specific
  research: [
    { min: 60000000, max: 69999999, confidence: 0.4, subtype: 'Research/Scientific' }
  ]
};

// Embassy-specific adjustments (some embassies handle specific visa types)
export const EMBASSY_VISA_FOCUS = {
  'new-delhi': ['study', 'work', 'visit', 'family'],
  'beijing': ['study', 'visit', 'work'],
  'dublin': ['work', 'family', 'transfer'],
  'abu-dhabi': ['visit', 'work', 'family'],
  'abuja': ['visit', 'family', 'study'],
  'ankara': ['visit', 'work', 'family']
};

/**
 * Detect visa type from application number
 */
export function detectVisaType(applicationNumber, embassySlug = null) {
  const num = parseInt(applicationNumber, 10);
  if (isNaN(num)) return { type: 'unknown', confidence: 0 };
  
  let bestMatch = { type: 'unknown', confidence: 0, subtype: '' };
  
  // Check all ranges
  for (const [type, ranges] of Object.entries(VISA_TYPE_RANGES)) {
    for (const range of ranges) {
      if (num >= range.min && num <= range.max) {
        let confidence = range.confidence;
        
        // Boost confidence if embassy matches visa focus
        if (embassySlug && EMBASSY_VISA_FOCUS[embassySlug]?.includes(type)) {
          confidence += 0.15;
        }
        
        if (confidence > bestMatch.confidence) {
          bestMatch = { 
            type, 
            confidence: Math.min(confidence, 0.95), 
            subtype: range.subtype 
          };
        }
      }
    }
  }
  
  return bestMatch;
}

/**
 * Get all possible visa types for an application number (for ambiguous cases)
 */
export function getPossibleVisaTypes(applicationNumber, embassySlug = null) {
  const num = parseInt(applicationNumber, 10);
  if (isNaN(num)) return [];
  
  const matches = [];
  
  for (const [type, ranges] of Object.entries(VISA_TYPE_RANGES)) {
    for (const range of ranges) {
      if (num >= range.min && num <= range.max) {
        let confidence = range.confidence;
        if (embassySlug && EMBASSY_VISA_FOCUS[embassySlug]?.includes(type)) {
          confidence += 0.15;
        }
        matches.push({ type, confidence: Math.min(confidence, 0.95), subtype: range.subtype });
      }
    }
  }
  
  return matches.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Get visa type display info for UI
 */
export function getVisaTypeDisplay(visaType) {
  const displays = {
    study: { label: 'Study', icon: 'graduation-cap', color: '#3b82f6', description: 'Stamp 2/2A - Degree programmes, English language courses' },
    work: { label: 'Work', icon: 'briefcase', color: '#059669', description: 'Stamp 1/1G/1H/4 - Employment, critical skills, intra-company transfer' },
    visit: { label: 'Visit', icon: 'plane', color: '#f59e0b', description: 'Short Stay C - Tourism, business, family visit (90 days)' },
    family: { label: 'Family', icon: 'users', color: '#ec4899', description: 'Stamp 3/4 - Join family, spouse, de facto partner' },
    transit: { label: 'Transit', icon: 'rotate-ccw', color: '#6366f1', description: 'Airport transit visa (24 hours)' },
    research: { label: 'Research', icon: 'flask-conical', color: '#8b5cf6', description: 'Hosting agreement, scientific research' },
    unknown: { label: 'Unknown', icon: 'help-circle', color: '#6b7280', description: 'Visa type could not be determined' }
  };
  
  return displays[visaType] || displays.unknown;
}

/**
 * Detect visa type from decision data (for batch processing)
 */
export function detectVisaTypesFromDecisions(decisions) {
  const results = {};
  
  decisions.forEach(d => {
    const detection = detectVisaType(d.number, d.embassy);
    const key = `${detection.type}:${detection.subtype}`;
    if (!results[key]) {
      results[key] = { type: detection.type, subtype: detection.subtype, count: 0, confidence: detection.confidence };
    }
    results[key].count++;
  });
  
  return Object.values(results).sort((a, b) => b.count - a.count);
}

export default {
  detectVisaType,
  getPossibleVisaTypes,
  getVisaTypeDisplay,
  detectVisaTypesFromDecisions,
  VISA_TYPE_RANGES,
  EMBASSY_VISA_FOCUS
};
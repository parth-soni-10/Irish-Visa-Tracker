
/**
 * VFS Global Appointment Availability
 * Placeholder - requires browser rendering for real implementation
 */

async function scrapeVFSAppointments(embassy) {
  const embassyUrls = {
    'new-delhi': 'https://visa.vfsglobal.com/ind/en/irl',
    'mumbai': 'https://visa.vfsglobal.com/ind/en/irl',
    'chennai': 'https://visa.vfsglobal.com/ind/en/irl',
    'kolkata': 'https://visa.vfsglobal.com/ind/en/irl',
    'bangalore': 'https://visa.vfsglobal.com/ind/en/irl',
    'hyderabad': 'https://visa.vfsglobal.com/ind/en/irl',
    'pune': 'https://visa.vfsglobal.com/ind/en/irl',
    'ahmedabad': 'https://visa.vfsglobal.com/ind/en/irl',
    'jalandhar': 'https://visa.vfsglobal.com/ind/en/irl',
  };
  
  const url = embassyUrls[embassy];
  if (!url) return { success: false, error: 'Unknown embassy', embassy };
  
  try {
    const response = await fetch(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IrishVisaTracker/1.0)' }
    });
    const html = await response.text();
    
    // Parse for appointment indicators (this is basic - real impl needs browser)
    const hasAppointments = /appointment|available|book now|schedule/i.test(html);
    const maintenance = /maintenance|unavailable|temporarily closed/i.test(html);
    
    return {
      success: true,
      embassy,
      url,
      hasAppointments,
      maintenance,
      scrapedAt: new Date().toISOString(),
      note: 'Basic HTTP fetch - may not reflect JS-rendered content. Use Cloudflare Browser Rendering for production.'
    };
  } catch (err) {
    return { success: false, error: err.message, embassy };
  }
}

export async function handleVFSAppointments(request, env) {
  const url = new URL(request.url);
  const embassy = url.searchParams.get('embassy') || 'new-delhi';
  const result = await scrapeVFSAppointments(embassy);
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

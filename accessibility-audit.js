/**
 * Accessibility Audit Script
 * Runs axe-core accessibility tests against the site
 * Checks WCAG 2.1 AA compliance
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.AUDIT_BASE_URL || 'http://127.0.0.1:8788';

// Configuration
const PAGES_TO_TEST = [
  { url: '/', name: 'Home Page' },
  { url: '/vac-transit', name: 'VAC/Transit Page' },
  { url: '/admin', name: 'Admin Page' },
  { url: '/workspace', name: 'Workspace Page' },
];

const VIEWPORTS = [
  { width: 1920, height: 1080, name: 'desktop' },
  { width: 768, height: 1024, name: 'tablet' },
  { width: 375, height: 667, name: 'mobile' },
];

async function runAxeAudit(pageUrl, viewport) {
  console.log(`\n🔍 Testing ${pageUrl} at ${viewport.name} (${viewport.width}x${viewport.height})`);
  
  // Create a temporary Playwright script
  const script = `
const { chromium } = require('playwright');
const AxeBuilder = require('@axe-core/playwright').default;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: ${viewport.width}, height: ${viewport.height} }
  });
  const page = await context.newPage();
  
  try {
    await page.goto('${BASE_URL}${pageUrl}', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000); // Wait for dynamic content
    
    // Run all available rules
    const results = await new AxeBuilder({ page })
      .analyze();
    
    console.log(JSON.stringify(results, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
`;

  const scriptPath = path.join(__dirname, `temp-audit-${viewport.name}.cjs`);
  fs.writeFileSync(scriptPath, script);
  
  try {
    const output = execSync(`node ${scriptPath}`, { 
      encoding: 'utf8', 
      timeout: 60000,
      cwd: __dirname
    });
    fs.unlinkSync(scriptPath);
    return JSON.parse(output);
  } catch (error) {
    fs.unlinkSync(scriptPath);
    throw new Error(`Audit failed for ${viewport.name}: ${error.message}`);
  }
}

function generateReport(results, pageName, viewportName) {
  const violations = results.violations || [];
  const passes = results.passes || [];
  const incomplete = results.incomplete || [];
  
  let report = `\n## ${pageName} - ${viewportName}\n\n`;
  report += `**Violations:** ${violations.length} | **Passes:** ${passes.length} | **Incomplete:** ${incomplete.length}\n\n`;
  
  if (violations.length > 0) {
    report += `### ❌ Violations (${violations.length})\n\n`;
    violations.forEach(v => {
      report += `#### ${v.id} (${v.impact} impact)\n`;
      report += `${v.description}\n\n`;
      report += `**Help:** ${v.help}\n\n`;
      report += `**Help URL:** ${v.helpUrl}\n\n`;
      report += `**Nodes affected:** ${v.nodes.length}\n`;
      v.nodes.forEach(node => {
        report += `- \`${node.html}\`\n`;
        if (node.target) {
          report += `  Selector: \`${node.target.join(' ')}\`\n`;
        }
      });
      report += '\n';
    });
  }
  
  if (incomplete.length > 0) {
    report += `### ⚠️ Incomplete (${incomplete.length}) - Manual Review Required\n\n`;
    incomplete.forEach(i => {
      report += `- **${i.id}**: ${i.description}\n`;
    });
    report += '\n';
  }
  
  return report;
}

async function main() {
  console.log('🚀 Starting Accessibility Audit (WCAG 2.1 AA)');
  console.log('==============================================');
  
  // Check if dev server is running
  try {
    const response = await fetch(BASE_URL + '/');
    if (!response.ok) {
      throw new Error('Dev server not responding');
    }
  } catch (error) {
    console.error('❌ Dev server not running on ' + BASE_URL);
    console.log('Please run: npx wrangler pages dev . --port ' + (new URL(BASE_URL).port || '8788'));
    process.exit(1);
  }
  
  console.log('✅ Dev server is running');
  
  const allReports = [];
  let totalViolations = 0;
  let totalIncomplete = 0;
  
  for (const page of PAGES_TO_TEST) {
    for (const viewport of VIEWPORTS) {
      try {
        const results = await runAxeAudit(page.url, viewport);
        const report = generateReport(results, page.name, viewport.name);
        allReports.push(report);
        
        totalViolations += results.violations?.length || 0;
        totalIncomplete += results.incomplete?.length || 0;
        
        console.log(`✅ ${page.name} (${viewport.name}): ${results.violations?.length || 0} violations, ${results.incomplete?.length || 0} incomplete`);
      } catch (error) {
        console.error(`❌ Failed to audit ${page.name} (${viewport.name}):`, error.message);
      }
    }
  }
  
  // Generate summary report
  const summary = `
# Accessibility Audit Report (WCAG 2.1 AA)
**Generated:** ${new Date().toISOString()}
**Total Violations:** ${totalViolations}
**Total Incomplete (Manual Review):** ${totalIncomplete}

${allReports.join('\n---\n')}

## Summary

${totalViolations === 0 ? '✅ **No violations found!**' : `❌ **${totalViolations} violations found** - Fix required for WCAG 2.1 AA compliance`}

${totalIncomplete > 0 ? `⚠️ **${totalIncomplete} items need manual review**` : ''}

## Next Steps

1. Fix all violations (critical/high impact first)
2. Review incomplete items manually
3. Re-run audit after fixes
4. Test with screen readers (NVDA, JAWS, VoiceOver)
5. Test keyboard navigation
6. Verify color contrast ratios
`;

  console.log('\n' + '='.repeat(60));
  console.log('📊 AUDIT SUMMARY');
  console.log('='.repeat(60));
  console.log(summary);
  
  // Save report
  const reportPath = path.join(__dirname, 'accessibility-report.md');
  fs.writeFileSync(reportPath, summary);
  console.log(`\n📄 Report saved to: ${reportPath}`);
  
  // Exit with error code if violations found
  if (totalViolations > 0) {
    process.exit(1);
  }
}

main().catch(console.error);
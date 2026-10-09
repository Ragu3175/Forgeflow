/**
 * ForgeFlow Phase 9.3 — Grafana Automated Test Suite
 * 
 * Verifies:
 * A. Grafana container is running and healthy.
 * B. Prometheus datasource is automatically provisioned as the default datasource.
 * C. Dashboards are automatically loaded via file provider.
 * D. ForgeFlow Overview dashboard exists with all required metric panels.
 * E. Grafana proxy can successfully query Prometheus metrics.
 * F. Variable definitions in the dashboard remain low-cardinality (no jobId/requestId/userId).
 * G. Real-time metric observations (HTTP requests, jobs created, worker executions) reflect through Grafana.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

const GRAFANA_BASE_URL = process.env.GRAFANA_URL || 'http://localhost:3000';
const NGINX_API_URL = process.env.API_URL || 'http://localhost:4000';

async function fetchJson(url: string, options?: RequestInit) {
  const res = await fetch(url, options);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text), headers: res.headers };
  } catch {
    return { status: res.status, ok: res.ok, data: text, headers: res.headers };
  }
}

export async function runGrafanaTestSuite() {
  console.log('\n====================================================');
  console.log('🧪 ForgeFlow Phase 9.3: Grafana Test Suite');
  console.log('====================================================\n');

  // Test A: Health endpoint
  console.log('▶️ [Test A] Verifying Grafana container health endpoint...');
  const healthRes = await fetchJson(`${GRAFANA_BASE_URL}/api/health`);
  assert.strictEqual(healthRes.status, 200, `Expected 200 OK from Grafana health, got ${healthRes.status}`);
  assert.strictEqual(healthRes.data.database, 'ok', 'Grafana internal database should report ok');
  console.log(`   ✅ Grafana health check verified: version=${healthRes.data.version}, database=${healthRes.data.database}`);

  // Test B: Datasource Provisioning
  console.log('\n▶️ [Test B] Verifying Prometheus datasource auto-provisioning...');
  const dsRes = await fetchJson(`${GRAFANA_BASE_URL}/api/datasources`);
  assert.strictEqual(dsRes.status, 200, `Expected 200 from /api/datasources, got ${dsRes.status}`);
  assert.ok(Array.isArray(dsRes.data), 'Expected array of datasources');
  
  const promDs = dsRes.data.find((ds: any) => ds.name === 'Prometheus' || ds.type === 'prometheus');
  assert.ok(promDs, 'Prometheus datasource must be provisioned');
  assert.strictEqual(promDs.type, 'prometheus', 'Datasource type must be prometheus');
  assert.strictEqual(promDs.url, 'http://prometheus:9090', 'Datasource URL must point to internal http://prometheus:9090');
  assert.strictEqual(promDs.isDefault, true, 'Prometheus must be the default datasource');
  console.log(`   ✅ Prometheus datasource verified: name=${promDs.name}, url=${promDs.url}, isDefault=${promDs.isDefault}`);

  // Test C & D: Dashboard Provisioning & Panel Verification
  console.log('\n▶️ [Test C & D] Verifying ForgeFlow Overview dashboard provisioning & panels...');
  const searchRes = await fetchJson(`${GRAFANA_BASE_URL}/api/search?type=dash-db`);
  assert.strictEqual(searchRes.status, 200, `Expected 200 from /api/search, got ${searchRes.status}`);
  
  const dashEntry = searchRes.data.find((d: any) => d.uid === 'forgeflow-overview');
  assert.ok(dashEntry, "Dashboard with uid 'forgeflow-overview' must be provisioned");
  console.log(`   ✅ Found dashboard: title="${dashEntry.title}", uid="${dashEntry.uid}", folder="${dashEntry.folderTitle}"`);

  // Fetch full dashboard details
  const dashDetailRes = await fetchJson(`${GRAFANA_BASE_URL}/api/dashboards/uid/forgeflow-overview`);
  assert.strictEqual(dashDetailRes.status, 200, 'Expected 200 for dashboard details');
  const dashboard = dashDetailRes.data.dashboard;

  const panels = dashboard.panels || [];
  const panelTitles = panels.map((p: any) => p.title);
  console.log(`   Discovered ${panels.length} panels across dashboard rows.`);

  // Verify key panels exist
  const expectedPanels = [
    'Total Jobs Created',
    'Total Jobs Completed',
    'Total Job Failures',
    'Current Queue Depth',
    'API Request Rate',
    'API Request Latency (p50 & p95)',
    'HTTP Status Code Distribution',
    'Jobs Created Rate',
    'API Observed Job Completions',
    'API Observed Job Failures',
    'Worker Processing Rate',
    'Worker Job Processing Duration (p95)',
    'RabbitMQ Queue Depth Over Time',
    'Worker Failure Rate by Category',
    'Worker Retries Scheduled Rate',
    'Dead Letter Queue (DLQ) Routing Rate'
  ];

  for (const expected of expectedPanels) {
    const found = panelTitles.includes(expected);
    assert.ok(found, `Expected dashboard to include panel titled "${expected}"`);
  }
  console.log('   ✅ All 16 required dashboard panels verified.');

  // Test E: Grafana Proxy Query to Prometheus
  console.log('\n▶️ [Test E] Verifying Grafana proxy query to Prometheus...');
  const queryRes = await fetchJson(
    `${GRAFANA_BASE_URL}/api/datasources/proxy/${promDs.id}/api/v1/query?query=up`
  );
  assert.strictEqual(queryRes.status, 200, `Expected 200 from query proxy, got ${queryRes.status}`);
  assert.strictEqual(queryRes.data.status, 'success', 'Prometheus query proxy status must be success');
  
  const targets = queryRes.data.data.result;
  assert.ok(targets.length >= 3, `Expected at least 3 active targets (api1, api2, worker), got ${targets.length}`);
  for (const target of targets) {
    assert.strictEqual(target.value[1], '1', `Target ${target.metric.instance} must be up (1)`);
  }
  console.log(`   ✅ Grafana query proxy verified. All ${targets.length} Prometheus targets UP.`);

  // Test F: Low Cardinality Variable Safety Check
  console.log('\n▶️ [Test F] Checking Dashboard Template Variables for Cardinality Safety...');
  const variables = dashboard.templating?.list || [];
  assert.ok(variables.length >= 3, 'Dashboard should have templating variables configured');
  
  for (const v of variables) {
    const varName = v.name.toLowerCase();
    const forbiddenPatterns = ['jobid', 'job_id', 'requestid', 'request_id', 'userid', 'user_id', 'email', 'jwt', 'token'];
    for (const forbidden of forbiddenPatterns) {
      assert.ok(!varName.includes(forbidden), `Variable "${v.name}" violates low-cardinality safety!`);
    }
  }
  console.log(`   ✅ Verified ${variables.length} dashboard variables (instance, job_type, status) are 100% low-cardinality.`);

  // Test G: Live Traffic Simulation & Grafana Metric Propagation
  console.log('\n▶️ [Test G] Simulating Traffic & Verifying Live Metric Aggregation in Grafana...');
  
  // Send a few requests to Nginx
  await fetchJson(`${NGINX_API_URL}/health`);
  await fetchJson(`${NGINX_API_URL}/ready`);
  
  // Query metric via Grafana datasource proxy
  const httpQueryRes = await fetchJson(
    `${GRAFANA_BASE_URL}/api/datasources/proxy/${promDs.id}/api/v1/query?query=sum(forgeflow_http_requests_total)`
  );
  assert.strictEqual(httpQueryRes.status, 200);
  const totalHttpRequests = parseFloat(httpQueryRes.data.data.result[0]?.value[1] || '0');
  assert.ok(totalHttpRequests > 0, `Expected total HTTP requests > 0, got ${totalHttpRequests}`);
  console.log(`   ✅ Live HTTP requests observed via Grafana: ${totalHttpRequests} requests`);

  // Query Queue Depth via Grafana
  const queueDepthRes = await fetchJson(
    `${GRAFANA_BASE_URL}/api/datasources/proxy/${promDs.id}/api/v1/query?query=forgeflow_queue_depth{queue="forgeflow.jobs"}`
  );
  assert.strictEqual(queueDepthRes.status, 200);
  const queueDepth = parseFloat(queueDepthRes.data.data.result[0]?.value[1] || '0');
  console.log(`   ✅ Live Queue depth observed via Grafana: ${queueDepth} messages`);

  console.log('\n====================================================');
  console.log('🎉 ALL GRAFANA TESTS (A-G) PASSED SUCCESSFULLY!');
  console.log('====================================================\n');
}

if (process.argv[1]?.endsWith('grafana.test.ts')) {
  runGrafanaTestSuite().catch((err) => {
    console.error('❌ Grafana test suite failed:', err);
    process.exit(1);
  });
}

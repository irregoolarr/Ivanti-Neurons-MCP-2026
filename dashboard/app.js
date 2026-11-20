/* Ivanti Neurons Command Center — client. Fetches /api/data (live MCP snapshot) and renders it. */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  const fmt = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toLocaleString());
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const humanize = (s) => String(s).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const COLORS = ["#6d28d9", "#f97316", "#eab308", "#10b981", "#0ea5e9", "#e11d48"];
  const LABELS = { macos: "macOS", ios: "iOS", ipados: "iPadOS", hp: "HP", "hp-ux": "HP-UX", vmware: "VMware", ad: "AD", aix: "AIX", ibm: "IBM", lg: "LG" };
  const label = (k) => {
    const s = String(k);
    return LABELS[s.toLowerCase()] || (s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  };

  const TABS = [
    { id: "overview", label: "Environment Action", title: "Environment Action Dashboard", desc: "Current-state posture, risks and prioritized workstreams." },
    { id: "endpoint", label: "Unified Endpoint", title: "Unified Endpoint", desc: "Discovered devices, management coverage and device health.", domain: "device" },
    { id: "exposures", label: "Exposures", title: "Vulnerability & Exposure", desc: "Exposure and CVE data from the Exposures MCP server.", domain: "exposures" },
    { id: "patch", label: "Patch Status", title: "Patch Status", desc: "Patch deployment and risk data from the Patch MCP server.", domain: "patch" },
    { id: "software", label: "Software Inventory", title: "Software Inventory", desc: "Installed software, versions and end-of-life status.", domain: "software-inventory" },
    { id: "distribution", label: "Software Distribution", title: "Software Distribution", desc: "Package and deployment status.", domain: "software-distribution" },
    { id: "reporting", label: "Reporting", title: "Reporting Engine", desc: "Report configurations and execution history.", domain: "reporting" },
    { id: "dataservices", label: "Data Services", title: "Data Services", desc: "Data Services MCP server results.", domain: "dataservices" },
    { id: "target", label: "Target State", title: "Environment Target State", desc: "Where each KPI stands against its remediation target.", tag: "TARGET STATE" },
  ];

  let data = null;
  let tab = location.hash.slice(1) || "overview";

  /* ------------------------------ data helpers ------------------------------ */

  const domain = (id) => (data && data.domains.find((d) => d.id === id)) || null;
  const run = (domainId, tool) => {
    const d = domain(domainId);
    return d ? d.runs.find((r) => r.tool === tool && r.ok) : undefined;
  };
  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const k of ["result", "count", "total", "total_count", "totalCount", "value"]) if (typeof v[k] === "number") return v[k];
      if (v.pagination && typeof v.pagination.total_count === "number" && !Array.isArray(v.items)) return v.pagination.total_count;
    }
    return null;
  }
  const dev = (tool) => {
    const r = run("device", tool);
    return r ? num(r.data) : null;
  };
  function keyValueItems(v) {
    const items = v && Array.isArray(v.items) ? v.items : Array.isArray(v) ? v : null;
    if (!items || !items.length) return null;
    if (!items.every((i) => i && typeof i === "object" && "key" in i && typeof i.value === "number")) return null;
    return items.filter((i) => !i.__truncated).map((i) => ({ key: String(i.key), value: i.value }));
  }
  const groups = (tool) => {
    const r = run("device", tool);
    return (r && keyValueItems(r.data)) || [];
  };
  /** First numeric result in a domain whose tool name matches `re`. */
  function domainNumber(domainId, re) {
    const d = domain(domainId);
    if (!d) return null;
    for (const r of d.runs) if (r.ok && re.test(r.tool) && num(r.data) !== null) return { value: num(r.data), tool: r.tool };
    return null;
  }

  function model() {
    const total = dev("device_count");
    const managed = dev("device_managed_count");
    const manageable = dev("device_neurons_manageable_count");
    const os = run("device", "organization_score");
    const org = os && os.data && typeof os.data === "object" ? os.data : null;
    return {
      total,
      managed,
      manageable,
      unmanaged: total !== null && managed !== null ? total - managed : null,
      quickWins: manageable !== null && managed !== null ? Math.max(manageable - managed, 0) : null,
      recentDiscovered: dev("device_recent_discovery_count"),
      recentUpdated: dev("device_recent_updates_count"),
      stale: dev("device_stale_devices_count"),
      noRestart: dev("device_old_startup_count"),
      lowDisk: dev("device_low_disk_space_count"),
      avOff: dev("device_antivirus_disabled_count"),
      warrantyExpired: dev("device_warranty_expired_count"),
      warrantyExpiring: dev("device_warranty_expiring_count"),
      orgScore: org && org.OrganizationScore ? org.OrganizationScore.Score : null,
      subScores: org && org.DomainSubScores ? Object.entries(org.DomainSubScores).map(([k, v]) => ({ name: k, score: v && v.Score })) : [],
      exposures: domainNumber("exposures", /(exposure|cve|vuln)/i) || domainNumber("exposures", /./),
      eol: domainNumber("software-inventory", /(eol|end_?of_?life)/i),
    };
  }

  /* ------------------------------ UI building ------------------------------ */

  const scoreColor = (s) => (s >= 80 ? "#10b981" : s >= 50 ? "#6d28d9" : "#e11d48");

  function ring(score) {
    const r = 70, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, score || 0)) / 100;
    return `<div class="ring"><svg width="170" height="170" viewBox="0 0 170 170" aria-hidden="true">
      <circle cx="85" cy="85" r="${r}" fill="none" stroke="#ebe9f3" stroke-width="14"/>
      <circle cx="85" cy="85" r="${r}" fill="none" stroke="${scoreColor(score)}" stroke-width="14" stroke-linecap="round" stroke-dasharray="${c * p} ${c}"/>
      </svg><div class="val"><div><div class="num">${fmt(score)}</div><div class="lbl">ORG SCORE</div></div></div></div>`;
  }

  const bar = (p, color) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, p))}%;background:${color}"></i></div>`;

  function kpi(name, value, sub, accent, extra = "", small = false) {
    return `<div class="card kpi${small ? " small" : ""}" style="--accent:${accent || "var(--ink)"}">
      <div class="name">${esc(name)}</div><div class="v">${value}</div><div class="sub">${sub || ""}</div>${extra}</div>`;
  }

  function bars(items, color) {
    if (!items.length) return `<p class="empty">No data.</p>`;
    const max = Math.max(...items.map((i) => i.value), 1);
    return `<div class="rows">${items
      .map((i, n) => `<div class="row"><span class="k" title="${esc(i.key)}">${esc(label(i.key))}</span>${bar((i.value / max) * 100, color || COLORS[n % COLORS.length])}<span class="n">${fmt(i.value)}</span></div>`)
      .join("")}</div>`;
  }

  function notice(kind, title, html) {
    return `<div class="card notice ${kind}"><h3>${esc(title)}</h3><div>${html}</div></div>`;
  }

  /* ------------------------------ overview tab ------------------------------ */

  function actionsFor(m) {
    const A = [];
    if (m.unmanaged > 0 && m.total) {
      A.push({
        id: "mgmt", sev: "critical", count: m.unmanaged, unit: "unmanaged devices",
        title: "Close the Device Management Gap",
        text: `Only <b>${fmt(m.managed)} devices</b> (${pct(m.managed, m.total)}%) are actively managed out of ${fmt(m.total)} discovered.` +
          (m.quickWins ? ` An additional <b>${fmt(m.quickWins)}</b> devices are already Neurons-manageable but lack agents. Prioritize enrolling these quick-win devices first, then extend to the remaining unmanaged endpoints.` : ""),
        steps: ["Deploy the Neurons agent to priority device groups in waves", "Configure auto-enrollment policies for each OS type", "Review non-manageable records (printers, switches) and scope them out"],
      });
    }
    if (m.exposures && m.exposures.value > 0) {
      A.push({
        id: "exposures", sev: "critical", count: m.exposures.value, unit: "open exposures",
        title: "Remediate Critical Exposures",
        text: `${fmt(m.exposures.value)} exposures are currently open. Start with actively exploited and highest-risk CVEs.`,
        steps: ["Prioritize exploited / highest VRR CVEs", "Map CVEs to patch groups and deploy", "Re-scan and verify closure"],
      });
    }
    if (m.avOff > 0) {
      A.push({
        id: "av", sev: "critical", count: m.avOff, unit: "devices without active AV",
        title: "Re-enable Antivirus Protection",
        text: `${fmt(m.avOff)} devices report antivirus installed but not active.`,
        steps: ["Identify devices with inactive AV", "Push AV policy / restart the AV service", "Alert on future AV state changes"],
      });
    }
    if (m.warrantyExpired > 0 || m.warrantyExpiring > 0) {
      A.push({
        id: "warranty", sev: "high", count: (m.warrantyExpired || 0) + (m.warrantyExpiring || 0), unit: "warranty issues",
        title: "Resolve Warranty Coverage",
        text: `${fmt(m.warrantyExpired || 0)} devices are out of warranty${m.total ? ` (${pct(m.warrantyExpired || 0, m.total)}% of the fleet)` : ""} and ${fmt(m.warrantyExpiring || 0)} expire within 3 months.`,
        steps: ["Plan hardware refresh for expired devices", "Renew or extend expiring warranties", "Track warranty dates in procurement"],
      });
    }
    if (m.noRestart > 0) {
      A.push({
        id: "restart", sev: "medium", count: m.noRestart, unit: "not restarted in 30 days",
        title: "Enforce Restart Hygiene",
        text: `${fmt(m.noRestart)} devices have not restarted in over 30 days, which delays patch completion.`,
        steps: ["Create a maintenance-window restart policy", "Notify users of pending restarts"],
      });
    }
    if (m.lowDisk > 0) {
      A.push({
        id: "disk", sev: "medium", count: m.lowDisk, unit: "low disk space",
        title: "Free Up Disk Space",
        text: `${fmt(m.lowDisk)} devices have a drive with less than 1 GB free.`,
        steps: ["Run disk clean-up automation", "Review large caches and temp folders"],
      });
    }
    if (m.stale > 0) {
      A.push({
        id: "stale", sev: "medium", count: m.stale, unit: "stale records",
        title: "Clean Up Stale Device Records",
        text: `${fmt(m.stale)} devices have not been seen in 30 days.`,
        steps: ["Confirm retired devices", "Archive or remove stale records"],
      });
    }
    const weak = m.subScores.filter((s) => typeof s.score === "number" && s.score < 70).sort((a, b) => a.score - b.score)[0];
    if (weak) {
      A.push({
        id: "score-" + weak.name, sev: "high", count: weak.score, unit: `${weak.name.toLowerCase()} score`,
        title: `Raise the ${weak.name} Score`,
        text: `${weak.name} is the weakest DEX sub-score at ${weak.score}. Focus remediation here to lift the organization score fastest.`,
        steps: [`Review ${weak.name.toLowerCase()} findings in Neurons DEX`, "Automate fixes with Neurons bots"],
      });
    }
    const order = { critical: 0, high: 1, medium: 2 };
    return A.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  function checked(id) {
    try { return JSON.parse(localStorage.getItem("ivanti-checks") || "{}")[id] === true; } catch { return false; }
  }
  function setChecked(id, v) {
    try {
      const s = JSON.parse(localStorage.getItem("ivanti-checks") || "{}");
      s[id] = v;
      localStorage.setItem("ivanti-checks", JSON.stringify(s));
    } catch { /* storage unavailable */ }
  }

  function overview() {
    const m = model();
    const out = [];
    if (data.persistentStore === false) {
      out.push(notice("", "Storage not connected", "Add an <b>Upstash Redis</b> store to this Vercel project (Storage tab) so the Ivanti sign-in and cached data survive restarts."));
    }

    out.push(`<div class="card score-panel">${ring(m.orgScore)}<div class="subscores">${
      m.subScores.length
        ? m.subScores.map((s, i) => `<div class="subscore"><div class="name">${esc(s.name)}</div><div class="v" style="color:${COLORS[i % COLORS.length]}">${fmt(s.score)}</div>${bar(s.score, COLORS[i % COLORS.length])}</div>`).join("")
        : `<p class="empty">Organization score not available.</p>`
    }</div></div>`);

    const gap = m.total ? pct(m.unmanaged, m.total) : null;
    const tiles = [
      kpi("Management Gap", gap === null ? "—" : gap + "%", m.total ? `Only ${fmt(m.managed)} of ${fmt(m.total)} devices managed` : "", "#e11d48",
        m.total ? `<div class="bar" style="display:flex"><i style="width:${pct(m.managed, m.total)}%;background:#10b981"></i><i style="width:${pct(m.quickWins || 0, m.total)}%;background:#c4b5fd;border-radius:0"></i></div>` : ""),
      m.exposures
        ? kpi("Open Exposures", fmt(m.exposures.value), esc(humanize(m.exposures.tool)), "#e11d48")
        : kpi("Antivirus Inactive", fmt(m.avOff), "Devices with AV installed but off", "#e11d48"),
      kpi("Expired Warranties", fmt(m.warrantyExpired), m.total ? `${pct(m.warrantyExpired || 0, m.total)}% of total fleet · ${fmt(m.warrantyExpiring)} expiring in 3 mo` : "", "#f97316"),
      m.eol
        ? kpi("EOL Software", fmt(m.eol.value), "Titles approaching or past end of life", "#eab308")
        : kpi("Stale Devices", fmt(m.stale), "Not seen in 30 days", "#eab308"),
    ];
    out.push(`<div class="grid g4">${tiles.join("")}</div>`);

    const actions = actionsFor(m);
    out.push(`<div class="section-title">Recommended Actions <span class="badge ${actions.length ? "" : "green"}">${actions.length} action${actions.length === 1 ? "" : "s"}</span></div>`);
    if (!actions.length) out.push(notice("ok", "No open actions", "Every tracked KPI is at target."));
    actions.forEach((a, i) => {
      out.push(`<div class="card action ${a.sev}"><div class="idx">${i + 1}</div><div><h4>${esc(a.title)}</h4><p>${a.text}</p><div class="checks">${a.steps
        .map((s, j) => {
          const id = a.id + ":" + j;
          return `<label><input type="checkbox" data-check="${esc(id)}" ${checked(id) ? "checked" : ""}/> ${esc(s)}</label>`;
        })
        .join("")}</div></div><div class="big"><div class="v">${fmt(a.count)}</div><div class="l">${esc(a.unit)}</div></div></div>`);
    });
    return out.join("");
  }

  /* ------------------------------ endpoint tab ------------------------------ */

  function endpoint() {
    const d = domain("device");
    if (!d || !d.ok) return domainError(d, "Device");
    const m = model();
    const out = [];
    out.push(`<div class="grid g4">${[
      kpi("Discovered Devices", fmt(m.total), "All devices in Discovery", "#6d28d9", "", true),
      kpi("Managed", fmt(m.managed), m.total ? pct(m.managed, m.total) + "% of fleet" : "", "#10b981", "", true),
      kpi("Neurons-Manageable", fmt(m.manageable), m.quickWins !== null ? `${fmt(m.quickWins)} quick wins without agent` : "", "#0ea5e9", "", true),
      kpi("Unmanaged", fmt(m.unmanaged), "Discovered but not managed", "#e11d48", "", true),
      kpi("New (7 days)", fmt(m.recentDiscovered), "First discovered this week", "#6d28d9", "", true),
      kpi("Updated (7 days)", fmt(m.recentUpdated), "Records refreshed this week", "#6d28d9", "", true),
      kpi("Stale (30 days)", fmt(m.stale), "Not seen recently", "#eab308", "", true),
      kpi("No Restart (30 days)", fmt(m.noRestart), "Pending restarts", "#eab308", "", true),
      kpi("Low Disk Space", fmt(m.lowDisk), "A drive under 1 GB free", "#f97316", "", true),
      kpi("Antivirus Inactive", fmt(m.avOff), "AV present but off", "#e11d48", "", true),
      kpi("Warranty Expired", fmt(m.warrantyExpired), "Past expiration date", "#f97316", "", true),
      kpi("Warranty Expiring", fmt(m.warrantyExpiring), "Within 3 months", "#eab308", "", true),
    ].join("")}</div>`);

    if (m.total) {
      const step = (label, v, color) => `<div class="step"><span>${label}</span>${bar(pct(v || 0, m.total), color)}<b style="text-align:right">${fmt(v)}</b></div>`;
      out.push(`<div class="card"><h3>Management Coverage</h3><div class="funnel">${step("Discovered", m.total, "#6d28d9")}${step("Neurons-manageable", m.manageable, "#a78bfa")}${step("Managed", m.managed, "#10b981")}</div></div>`);
    }

    out.push(`<div class="grid g2">
      <div class="card"><h3>Operating Systems</h3>${bars(groups("device_os_groups"))}</div>
      <div class="card"><h3>Manufacturers</h3>${bars(groups("device_manufacturer_groups"))}</div>
      <div class="card"><h3>Device Types</h3>${bars(groups("device_type_groups"))}</div>
      <div class="card"><h3>Discovery Sources</h3>${bars(groups("device_provider_groups"))}</div>
    </div>`);
    out.push(failedRuns(d));
    return out.join("");
  }

  /* ------------------------------ generic domain tabs ------------------------------ */

  function domainError(d, label) {
    if (!d) return notice("", `${label} not configured`, "This domain is not in NEURONS_MCP_DOMAINS.");
    return notice("err", `${label} data unavailable`,
      `<p>${esc(d.error || "Unknown error")}</p><p class="empty">This usually means the domain isn't enabled or licensed on the tenant, or your Ivanti account has no access to it.</p>`);
  }

  function failedRuns(d) {
    const failed = d.runs.filter((r) => !r.ok);
    if (!failed.length) return "";
    return `<details><summary>${failed.length} tool call(s) returned no data</summary><ul>${failed
      .map((r) => `<li><code>${esc(r.tool)}</code> — ${esc((r.error || "").slice(0, 200))}</li>`)
      .join("")}</ul></details>`;
  }

  function arrayOfObjects(v) {
    if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object" && !x.__truncated);
    if (v && typeof v === "object") {
      for (const k of ["items", "data", "value", "results", "records", "rows"]) {
        if (Array.isArray(v[k]) && v[k].some((x) => x && typeof x === "object")) return v[k].filter((x) => x && typeof x === "object" && !x.__truncated);
      }
    }
    return null;
  }

  function cell(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return esc(JSON.stringify(v).slice(0, 80));
    if (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v)) return esc(new Date(v).toLocaleString());
    return esc(v);
  }

  function table(rows) {
    const cols = [];
    for (const r of rows.slice(0, 25)) for (const k of Object.keys(r)) if (!cols.includes(k) && cols.length < 7) cols.push(k);
    return `<div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(humanize(c))}</th>`).join("")}</tr></thead><tbody>${rows
      .slice(0, 15)
      .map((r) => `<tr>${cols.map((c) => `<td title="${cell(r[c])}">${cell(r[c])}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>${rows.length > 15 ? `<p class="empty">Showing 15 of ${rows.length}${data ? "" : ""}.</p>` : ""}`;
  }

  function renderValue(v) {
    const kv = keyValueItems(v);
    if (kv) return bars(kv);
    const rows = arrayOfObjects(v);
    if (rows && rows.length) return table(rows);
    if (rows && !rows.length) return `<p class="empty">No records.</p>`;
    if (v && typeof v === "object") {
      const flat = Object.entries(v).filter(([, x]) => x === null || typeof x !== "object");
      const nested = Object.entries(v).filter(([, x]) => x && typeof x === "object");
      let html = flat.length ? `<dl class="kv">${flat.map(([k, x]) => `<dt>${esc(humanize(k))}</dt><dd>${cell(x)}</dd>`).join("")}</dl>` : "";
      for (const [k, x] of nested.slice(0, 3)) html += `<h4 style="margin:14px 0 8px">${esc(humanize(k))}</h4>${renderValue(x)}`;
      return html || `<pre class="raw">${esc(JSON.stringify(v, null, 2))}</pre>`;
    }
    return `<pre class="raw">${esc(String(v))}</pre>`;
  }

  function genericDomain(id, label) {
    const d = domain(id);
    if (!d || !d.ok) return domainError(d, label);
    const ok = d.runs.filter((r) => r.ok);
    if (!ok.length) {
      return notice("", `No summary data from ${label}`, `The ${esc(label)} MCP server offers ${fmt(d.toolCount)} tools, but none are argument-free summaries the dashboard can call automatically.`) + failedRuns(d);
    }
    const nums = ok.filter((r) => num(r.data) !== null);
    const rest = ok.filter((r) => num(r.data) === null);
    const out = [];
    if (nums.length) {
      out.push(`<div class="grid g4">${nums
        .map((r, i) => kpi(r.title || humanize(r.tool), fmt(num(r.data)), esc((r.description || "").split(/[.\n]/)[0].slice(0, 90)), COLORS[i % COLORS.length], "", true))
        .join("")}</div>`);
    }
    if (rest.length) {
      out.push(`<div class="grid g2">${rest
        .map((r) => `<div class="card"><h3>${esc(r.title || humanize(r.tool))}</h3>${r.description ? `<p class="hint">${esc(r.description.split(/\n/)[0].slice(0, 160))}</p>` : ""}${renderValue(r.data)}<details><summary>Raw data</summary><pre class="raw">${esc(JSON.stringify(r.data, null, 2))}</pre></details></div>`)
        .join("")}</div>`);
    }
    out.push(failedRuns(d));
    return out.join("");
  }

  /* ------------------------------ target state tab ------------------------------ */

  function target() {
    const m = model();
    const rows = [
      ["Management coverage", m.total ? pct(m.managed, m.total) : null, 100, "%", `${fmt(m.managed)} of ${fmt(m.total)} devices managed`, true],
      ["Organization score", m.orgScore, 90, "", "DEX organization score", true],
      ["Warranty coverage", m.total && m.warrantyExpired !== null ? pct(m.total - m.warrantyExpired, m.total) : null, 100, "%", `${fmt(m.warrantyExpired)} expired`, true],
      ["Active antivirus", m.total && m.avOff !== null ? pct(m.total - m.avOff, m.total) : null, 100, "%", `${fmt(m.avOff)} devices with AV off`, true],
      ["Restarted within 30 days", m.total && m.noRestart !== null ? pct(m.total - m.noRestart, m.total) : null, 100, "%", `${fmt(m.noRestart)} pending restarts`, true],
    ];
    if (m.exposures) rows.push(["Open exposures", m.exposures.value, 0, "", "Target: zero open exposures", false]);
    const card = ([name, cur, goal, unit, sub, higherIsBetter]) => {
      const done = cur !== null && (higherIsBetter ? cur >= goal : cur <= goal);
      const progress = cur === null ? 0 : higherIsBetter ? (cur / goal) * 100 : cur === 0 ? 100 : 0;
      return kpi(name, `${fmt(cur)}${cur === null ? "" : unit} <span style="font-size:15px;color:#6b6880;font-weight:600">→ ${goal}${unit}</span>`, sub, done ? "#10b981" : "#6d28d9", bar(progress, done ? "#10b981" : "#6d28d9"));
    };
    const remaining = rows.filter(([, cur, goal, , , hib]) => cur !== null && (hib ? cur < goal : cur > goal)).length;
    return (
      notice(remaining ? "" : "ok", remaining ? `${remaining} KPI${remaining === 1 ? "" : "s"} below target` : "All KPIs at target",
        "Targets are fixed goals for a fully managed, patched and compliant estate. Current values are live from Ivanti; progress bars show the distance to each goal.") +
      `<div class="grid g4">${rows.map(card).join("")}</div>`
    );
  }

  /* ------------------------------ shell ------------------------------ */

  function renderTabs() {
    $("#tabs").innerHTML = TABS.filter((t) => !t.domain || !data || domain(t.domain))
      .map((t) => {
        const d = t.domain && data ? domain(t.domain) : null;
        const off = d && (!d.ok || (t.domain !== "device" && !d.runs.some((r) => r.ok)));
        return `<button role="tab" data-tab="${t.id}" aria-selected="${t.id === tab}" class="${off ? "off" : ""}">${esc(t.label)}</button>`;
      })
      .join("");
  }

  function render() {
    const t = TABS.find((x) => x.id === tab) || TABS[0];
    tab = t.id;
    renderTabs();
    $("#view-title").textContent = t.title;
    $("#view-desc").textContent = t.desc;
    $("#tag").textContent = t.tag || "CURRENT STATE";
    if (!data) return;
    let html;
    if (t.id === "overview") html = overview();
    else if (t.id === "endpoint") html = endpoint();
    else if (t.id === "target") html = target();
    else html = genericDomain(t.domain, t.label);
    $("#main").innerHTML = html;
  }

  function header() {
    const m = model();
    const when = new Date(data.generatedAt);
    const parts = [`Generated ${when.toLocaleString()}`];
    if (m.total !== null) parts.push(`${fmt(m.total)} discovered devices`);
    if (m.exposures) parts.push(`${fmt(m.exposures.value)} known exposures`);
    if (data.tenantHost) parts.push(`Tenant ${data.tenantHost}`);
    $("#meta").textContent = parts.join(" · ");
    const ageMin = Math.round((Date.now() - when.getTime()) / 60000);
    const live = $("#live");
    live.className = "live-pill" + (ageMin > 60 ? " stale" : "");
    live.innerHTML = `<span class="dot"></span>${ageMin <= 1 ? "Live Data" : `Updated ${ageMin} min ago`}`;
    $("#foot").textContent = `collected in ${(data.durationMs / 1000).toFixed(1)}s · ${data.domains.filter((d) => d.ok).length}/${data.domains.length} domains reachable`;
  }

  async function load(force) {
    const btn = $("#refresh");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    if (!data) $("#main").innerHTML = `<div class="loading"><div class="spinner"></div>Collecting live data from Ivanti Neurons… the first load can take up to a minute.</div>`;
    try {
      const res = await fetch("/api/data" + (force ? "?refresh=1" : ""), { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (res.status === 401) return void (location.href = "/login");
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        $("#meta").textContent = "Not connected to Ivanti yet";
        $("#main").innerHTML = notice("", "Connect the dashboard to Ivanti",
          `<p>${esc(body.message || "Sign-in required.")}</p><p>On your computer, in the project folder, run:</p><pre class="raw">npm run login -- --app ${esc(location.origin)}</pre><p>It opens Ivanti's sign-in page, then uploads the sign-in here using your dashboard password.</p>` +
            (body.persistentStore === false ? `<p><b>First</b> add an Upstash Redis store to this Vercel project (Storage tab), otherwise the sign-in can't be saved.</p>` : ""));
        return;
      }
      if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
      data = body;
      header();
      render();
    } catch (err) {
      $("#main").innerHTML = notice("err", "Could not load data", `<p>${esc(err.message)}</p>`) + ($("#main").innerHTML.includes("loading") ? "" : "");
    } finally {
      btn.disabled = false;
      btn.textContent = "Refresh";
    }
  }

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    history.replaceState(null, "", "#" + tab);
    render();
  });
  $("#main").addEventListener("change", (e) => {
    const c = e.target.closest("input[data-check]");
    if (c) setChecked(c.dataset.check, c.checked);
  });
  $("#refresh").addEventListener("click", () => load(true));
  window.addEventListener("hashchange", () => {
    tab = location.hash.slice(1) || "overview";
    render();
  });

  render();
  load(false);
  setInterval(() => document.visibilityState === "visible" && load(false), 5 * 60_000);
})();

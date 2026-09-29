/**
 * 研发生产计划看板 — 静态原型
 * 路由：#/  |  #/project/:id  |  #/project/:id/bom|kit
 * （旧路由 #/.../arrival|purchase 重定向到 kit）
 */
(function () {
  const LS_KEY = "rd-plan-board-overrides-v1";
  const DATA_URL = "./sample-data.json";

  /** @type {any} */
  let DATA = null;
  /** plan date overrides: { [activity_id]: { plan_start, plan_end } } */
  let overrides = loadOverrides();

  const app = document.getElementById("app");
  const crumb = document.getElementById("breadcrumb");
  const todayLabel = document.getElementById("todayLabel");

  document.getElementById("btnReset").addEventListener("click", () => {
    if (confirm("清除本地对计划日期的修改，恢复样例数据？")) {
      localStorage.removeItem(LS_KEY);
      // legacy commit drafts no longer used (交期仅来自 Excel/JSON)
      try { localStorage.removeItem("rd-plan-board-commit-v1"); } catch (_) {}
      overrides = {};
      render();
      showToast("已重置本地修改");
    }
  });

  window.addEventListener("hashchange", render);

  function loadOverrides() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }
  function saveOverrides() {
    localStorage.setItem(LS_KEY, JSON.stringify(overrides));
  }

  /** Read-only: commit_date comes from sample-data.json (Excel sync). */
  function getCommitDate(m) {
    return (m && m.commit_date) || "";
  }

  /** Latest BOM version per project: max bom_version (string), then max bom_updated_at. */
  function latestBomVersion(projectId) {
    const rows = DATA.bom.filter((b) => b.project_id === projectId);
    if (!rows.length) return null;
    let best = rows[0];
    for (const r of rows) {
      const bv = String(r.bom_version || "");
      const bb = String(best.bom_version || "");
      if (bv > bb) best = r;
      else if (bv === bb && String(r.bom_updated_at || "") > String(best.bom_updated_at || "")) best = r;
    }
    return { version: best.bom_version, updated_at: best.bom_updated_at };
  }

  function latestBomRows(projectId) {
    const latest = latestBomVersion(projectId);
    if (!latest) return [];
    const rows = DATA.bom.filter(
      (b) => b.project_id === projectId && String(b.bom_version || "") === String(latest.version || "")
    );
    return sortBomRows(rows);
  }

  /** Keep obsolete+replacement pairs together; pure 新增 at end; else stable by bom_line_id. */
  function sortBomRows(rows) {
    const byId = Object.fromEntries(rows.map((r) => [r.bom_line_id, { row: r, idx: 0 }]));
    rows.forEach((r, i) => {
      if (byId[r.bom_line_id]) byId[r.bom_line_id].idx = i;
    });
    const used = new Set();
    const out = [];
    const adds = [];

    function emit(r) {
      if (!r || used.has(r.bom_line_id)) return;
      used.add(r.bom_line_id);
      out.push(r);
    }

    // Walk in original order; when hitting obsolete or its replacement, emit old then new
    rows.forEach((r) => {
      if (used.has(r.bom_line_id)) return;
      if ((r.change_type || "") === "新增") {
        adds.push(r);
        used.add(r.bom_line_id);
        return;
      }
      // If this is the new replacement row, emit old first
      if (r.replaces_line_id && byId[r.replaces_line_id]) {
        emit(byId[r.replaces_line_id].row);
        emit(r);
        return;
      }
      // If obsolete, emit self then replacement
      if ((r.line_status || "") === "已替换" || r.replaced_by_line_id) {
        emit(r);
        if (r.replaced_by_line_id && byId[r.replaced_by_line_id]) {
          emit(byId[r.replaced_by_line_id].row);
        }
        return;
      }
      emit(r);
    });
    return out.concat(adds.filter((r) => !out.includes(r)));
  }

  function isObsoleteBom(r) {
    if (!r) return false;
    if ((r.line_status || "") === "已替换") return true;
    if (r.replaced_by_line_id) return true;
    if ((r.change_type || "") === "替换" && !r.replaces_line_id) return true;
    return Number(r.qty_per) === 0 && !r.replaces_line_id && (r.change_type === "替换" || r.replaced_by_line_id);
  }

  function computeArrivalStatus(m) {
    const stored = (m.arrival_status || "").trim();
    if (stored && ["已齐套", "缺料", "待检验", "待入库"].includes(stored)) return stored;
    if (numOr0(m.qty_pending_inspect) > 0) return "待检验";
    if (numOr0(m.qty_pending_inbound) > 0) return "待入库";
    const gap =
      m.qty_gap != null && m.qty_gap !== ""
        ? Number(m.qty_gap)
        : Math.max(0, numOr0(m.qty_required) - sumStock(m) - numOr0(m.qty_in_transit));
    if (gap <= 0) return "已齐套";
    return "缺料";
  }

  function enrichMaterialRow(m) {
    const base = ensureGap(m);
    // Prefer purchase_replies if commit_date empty
    let commit = base.commit_date || "";
    if (!commit && DATA.purchase_replies) {
      const replies = DATA.purchase_replies.filter(
        (r) =>
          r.project_id === base.project_id &&
          (r.material_line_id === base.material_line_id ||
            (!r.material_line_id && r.material_code === base.material_code))
      );
      replies.sort((a, b) => String(b.reply_date || "").localeCompare(String(a.reply_date || "")));
      if (replies[0] && replies[0].commit_date) commit = replies[0].commit_date;
    }
    const withCommit = { ...base, commit_date: commit };
    return {
      ...withCommit,
      arrival_status: computeArrivalStatus(withCommit),
    };
  }

  function todayStr() {
    const q = new URLSearchParams(location.search).get("asof");
    if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return q;
    return todayLocalISO();
  }

  function parseDate(s) {
    if (!s) return null;
    const d = new Date(s + "T00:00:00");
    return isNaN(d.getTime()) ? null : d;
  }

  function daysBetween(a, b) {
    return Math.round((b - a) / 86400000);
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function fmt(d) {
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function isComplete(status) {
    return status === "已完成" || status === "完成" || status === "closed" || status === "Closed";
  }

  function isOverdue(act, today) {
    if (isComplete(act.status)) return false;
    const pe = parseDate(act.plan_end);
    if (!pe) return false;
    return pe < today;
  }

  function getActivity(raw) {
    const o = overrides[raw.activity_id] || {};
    return {
      ...raw,
      plan_start: o.plan_start || raw.plan_start,
      plan_end: o.plan_end || raw.plan_end,
    };
  }

  function kitRate(projectId) {
    const mats = DATA.materials.filter((m) => m.project_id === projectId).map(enrichMaterialRow);
    if (!mats.length) return null;
    const ok = mats.filter((m) => m.arrival_status === "已齐套").length;
    return Math.round((ok / mats.length) * 100);
  }

  function openIssues(projectId) {
    return DATA.issues.filter(
      (i) => i.project_id === projectId && i.status !== "已关闭" && i.status !== "关闭"
    );
  }

  function riskClass(level) {
    return "risk-" + (level || "中");
  }

  function parseRoute() {
    const h = (location.hash || "#/").replace(/^#/, "") || "/";
    const parts = h.split("/").filter(Boolean);
    if (parts.length === 0) return { page: "list" };
    if (parts[0] === "project" && parts[1]) {
      const id = decodeURIComponent(parts[1]);
      const sub = parts[2] || "detail";
      return { page: "project", id, sub };
    }
    return { page: "list" };
  }

  function setCrumb(items) {
    crumb.innerHTML = items
      .map((it, i) => {
        if (i === items.length - 1 || !it.href) {
          return `<span>${escapeHtml(it.label)}</span>`;
        }
        return `<a href="${it.href}">${escapeHtml(it.label)}</a><span class="sep">/</span>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function numOr0(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Sum warehouse location stock; fall back to qty_stock. */
  function sumStock(m) {
    const hasLoc =
      (m.qty_stock_zibo != null && m.qty_stock_zibo !== "") ||
      (m.qty_stock_tianjin != null && m.qty_stock_tianjin !== "") ||
      (m.qty_stock_beijing != null && m.qty_stock_beijing !== "");
    if (hasLoc) {
      return numOr0(m.qty_stock_zibo) + numOr0(m.qty_stock_tianjin) + numOr0(m.qty_stock_beijing);
    }
    return numOr0(m.qty_stock);
  }

  function ensureGap(m) {
    const stock = sumStock(m);
    const gap =
      m.qty_gap != null && m.qty_gap !== ""
        ? Number(m.qty_gap)
        : Math.max(0, numOr0(m.qty_required) - stock - numOr0(m.qty_in_transit));
    return { ...m, qty_stock: stock, qty_gap: gap };
  }

  function lineIdCell(id, fallbackIdx) {
    const v = id != null && id !== "" ? id : "行" + (fallbackIdx + 1);
    return `<span class="line-id" title="行主键">${escapeHtml(v)}</span>`;
  }

  // ---------- List ----------
  function renderList() {
    setCrumb([{ label: "项目列表" }]);
    const projects = DATA.projects.slice();

    app.innerHTML = `
      <div class="toolbar">
        <strong style="font-size:15px">项目列表</strong>
        <span class="spacer"></span>
        <input class="search" id="q" type="search" placeholder="搜索项目名称 / 负责人 / 影响点…" />
        <select class="filter-select" id="riskFilter">
          <option value="">全部风险</option>
          <option value="低">低</option>
          <option value="中">中</option>
          <option value="高">高</option>
          <option value="严重">严重</option>
        </select>
      </div>
      <div class="card-grid" id="list"></div>
    `;

    const listEl = document.getElementById("list");
    const qEl = document.getElementById("q");
    const rf = document.getElementById("riskFilter");

    function paint() {
      const q = (qEl.value || "").trim().toLowerCase();
      const risk = rf.value;
      const rows = projects.filter((p) => {
        if (risk && p.risk_level !== risk) return false;
        if (!q) return true;
        const blob = [p.project_name, p.owner_name, p.main_impact, p.current_node, p.project_id]
          .join(" ")
          .toLowerCase();
        return blob.includes(q);
      });

      if (!rows.length) {
        listEl.innerHTML = `<div class="empty-hint">无匹配项目</div>`;
        return;
      }

      listEl.innerHTML = rows
        .map((p) => {
          const rate = kitRate(p.project_id);
          const issues = openIssues(p.project_id);
          return `
          <article class="project-card" data-id="${escapeHtml(p.project_id)}" tabindex="0" role="link">
            <div>
              <h3 class="name">${escapeHtml(p.project_name)}</h3>
              <div class="meta">
                ${escapeHtml(p.project_id)} · ${escapeHtml(p.project_type)} · ${escapeHtml(p.stage)}${p.ipd_phase ? " · IPD " + escapeHtml(p.ipd_phase) : ""}<br/>
                ${escapeHtml(p.owner_dept)} / ${escapeHtml(p.owner_name)} · 优先级 ${escapeHtml(p.priority)}
              </div>
            </div>
            <div>
              <div class="field-label">当前进度节点</div>
              <span class="node-chip">${escapeHtml(p.current_node || "—")}</span>
              <div class="stat-mini">
                ${rate == null ? "" : `<span>齐套率 ${rate}%</span>`}
                ${
                  issues.length
                    ? `<span class="warn">未关闭异常 ${issues.length}</span>`
                    : `<span>异常 0</span>`
                }
              </div>
            </div>
            <div>
              <div class="field-label">风险等级</div>
              <span class="risk-badge ${riskClass(p.risk_level)}">${escapeHtml(p.risk_level)}</span>
              <div class="meta" style="margin-top:8px">状态 ${escapeHtml(p.status)}</div>
            </div>
            <div>
              <div class="field-label">当前主要影响点</div>
              <div class="field-value impact-text">${escapeHtml(p.main_impact || "—")}</div>
            </div>
            <div>
              <div class="field-label">计划周期</div>
              <div class="field-value">${escapeHtml(p.plan_start)} ~ ${escapeHtml(p.plan_end)}</div>
              <div class="meta" style="margin-top:8px">目标数量 ${escapeHtml(p.target_qty)}</div>
            </div>
          </article>`;
        })
        .join("");

      listEl.querySelectorAll(".project-card").forEach((el) => {
        const go = () => {
          location.hash = `#/project/${encodeURIComponent(el.dataset.id)}`;
        };
        el.addEventListener("click", go);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            go();
          }
        });
      });
    }

    qEl.addEventListener("input", paint);
    rf.addEventListener("change", paint);
    paint();
  }


  function wbsParts(wbs) {
    if (wbs == null || wbs === "") return [];
    return String(wbs)
      .trim()
      .split(/[.\/\-]/)
      .filter(Boolean)
      .map((x) => {
        const n = Number(x);
        return Number.isFinite(n) ? n : x;
      });
  }

  /** Sort by WBS hierarchy (1 < 1.1 < 1.2 < 2); empty WBS last; then plan_start as tiebreaker. */
  function compareByWbs(a, b) {
    const pa = wbsParts(a.wbs);
    const pb = wbsParts(b.wbs);
    if (!pa.length && !pb.length) {
      return (a.plan_start || "").localeCompare(b.plan_start || "");
    }
    if (!pa.length) return 1;
    if (!pb.length) return -1;
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      if (i >= pa.length) return -1;
      if (i >= pb.length) return 1;
      const x = pa[i];
      const y = pb[i];
      if (x === y) continue;
      if (typeof x === "number" && typeof y === "number") return x - y;
      return String(x).localeCompare(String(y), "zh");
    }
    return (a.plan_start || "").localeCompare(b.plan_start || "");
  }

  // ---------- Project detail + Gantt ----------
  function renderProjectDetail(id) {
    const p = DATA.projects.find((x) => x.project_id === id);
    if (!p) {
      app.innerHTML = `<div class="error">未找到项目 ${escapeHtml(id)}</div>`;
      return;
    }
    setCrumb([
      { label: "项目列表", href: "#/" },
      { label: p.project_name },
    ]);

    const acts = DATA.activities
      .filter((a) => a.project_id === id)
      .map(getActivity)
      .sort(compareByWbs);

    const rate = kitRate(id);
    const issues = openIssues(id);

    app.innerHTML = `
      <div class="panel">
        <div class="toolbar" style="margin-bottom:8px">
          <h2 style="margin:0">${escapeHtml(p.project_name)}</h2>
          <span class="risk-badge ${riskClass(p.risk_level)}">${escapeHtml(p.risk_level)}</span>
          <span class="spacer"></span>
          <a class="btn secondary sm" href="#/">← 返回列表</a>
        </div>
        <div class="detail-grid">
          <div><div class="label">项目ID</div><div class="value">${escapeHtml(p.project_id)}</div></div>
          <div><div class="label">类型 / 阶段</div><div class="value">${escapeHtml(p.project_type)} / ${escapeHtml(p.stage)}${p.ipd_phase ? " · IPD " + escapeHtml(p.ipd_phase) : ""}</div></div>
          <div><div class="label">责任部门 / 人</div><div class="value">${escapeHtml(p.owner_dept)} / ${escapeHtml(p.owner_name)}</div></div>
          <div><div class="label">当前节点</div><div class="value"><span class="node-chip">${escapeHtml(p.current_node)}</span></div></div>
          <div><div class="label">计划周期</div><div class="value">${escapeHtml(p.plan_start)} ~ ${escapeHtml(p.plan_end)}</div></div>
          <div><div class="label">当前主要影响点</div><div class="value impact-text">${escapeHtml(p.main_impact || "—")}</div></div>
          <div><div class="label">齐套率</div><div class="value">${rate == null ? "—" : rate + "%"}</div></div>
          <div><div class="label">未关闭异常</div><div class="value">${issues.length}</div></div>
        </div>
        <div class="link-row">
          <a href="#/project/${encodeURIComponent(id)}">甘特详情</a>
          <a href="#/project/${encodeURIComponent(id)}/bom">最新BOM</a>
          <a href="#/project/${encodeURIComponent(id)}/kit">物料齐套表</a>
        </div>
      </div>

      <div class="panel">
        <h3>进度节点甘特图 <span style="font-weight:400;color:var(--muted);font-size:12px">（可编辑计划开始/结束，立即重绘）</span></h3>
        <div id="ganttHost"></div>
        <div class="legend">
          <span><i class="l-bar"></i>进行中/未开始</span>
          <span><i class="l-done"></i>已完成</span>
          <span><i class="l-overdue"></i>逾期未完成</span>
          <span><i class="l-today"></i>今天</span>
        </div>
      </div>

      ${
        issues.length
          ? `<div class="panel">
              <h3>相关异常</h3>
              <table class="data">
                <thead><tr><th>严重度</th><th>标题</th><th>类别</th><th>负责人</th><th>状态</th><th>影响</th></tr></thead>
                <tbody>
                  ${issues
                    .map(
                      (i) => `<tr>
                    <td><span class="risk-badge ${riskClass(i.severity)}">${escapeHtml(i.severity)}</span></td>
                    <td>${escapeHtml(i.title)}</td>
                    <td>${escapeHtml(i.category)}</td>
                    <td>${escapeHtml(i.owner_name)}</td>
                    <td>${escapeHtml(i.status)}</td>
                    <td>${i.impact_kit ? "齐套 " : ""}${i.impact_schedule ? "进度" : ""}</td>
                  </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : ""
      }
    `;

    mountGantt(document.getElementById("ganttHost"), acts, id);
  }

  function mountGantt(host, acts, projectId) {
    if (!acts.length) {
      host.innerHTML = `<div class="empty-hint">暂无计划活动</div>`;
      return;
    }

    const today = parseDate(todayStr());
    const allDates = [];
    acts.forEach((a) => {
      const s = parseDate(a.plan_start);
      const e = parseDate(a.plan_end);
      if (s) allDates.push(s);
      if (e) allDates.push(e);
    });
    allDates.push(today);

    let minD = new Date(Math.min(...allDates));
    let maxD = new Date(Math.max(...allDates));
    minD = addDays(minD, -3);
    maxD = addDays(maxD, 5);
    const totalDays = Math.max(1, daysBetween(minD, maxD));
    const dayW = Math.max(8, Math.min(18, Math.floor(720 / totalDays)));
    const timelineW = totalDays * dayW;

    // axis ticks ~ every week or month
    const tickStep = totalDays > 90 ? 14 : totalDays > 45 ? 7 : 5;
    const ticks = [];
    for (let i = 0; i <= totalDays; i += tickStep) {
      ticks.push({ i, label: fmt(addDays(minD, i)).slice(5) });
    }

    const todayOffset = daysBetween(minD, today);
    const todayLeft = todayOffset * dayW;

    const axisHtml = `
      <div class="gantt-header">
        <div>活动</div><div>状态</div><div>计划开始</div><div>计划结束</div>
        <div class="gantt-axis" style="--day-w:${dayW}px;width:${timelineW}px;max-width:100%">
          ${ticks.map((t) => `<span class="axis-tick" style="left:${t.i * dayW}px">${t.label}</span>`).join("")}
          ${
            todayOffset >= 0 && todayOffset <= totalDays
              ? `<div class="today-line" style="left:${todayLeft}px"></div>`
              : ""
          }
        </div>
      </div>`;

    const rowsHtml = acts
      .map((a) => {
        const overdue = isOverdue(a, today);
        const s = parseDate(a.plan_start);
        const e = parseDate(a.plan_end);
        let bar = "";
        if (s && e) {
          const left = daysBetween(minD, s) * dayW;
          const width = Math.max(dayW, (daysBetween(s, e) + 1) * dayW);
          const done = isComplete(a.status);
          const cls = [
            "bar",
            done ? "done" : "",
            a.is_milestone ? "milestone" : "",
            overdue ? "overdue-bar" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const pct = Math.min(100, Math.max(0, Number(a.progress_pct) || 0));
          bar = `<div class="${cls}" style="left:${left}px;width:${width}px" title="${escapeHtml(
            a.activity_name
          )} ${a.plan_start}~${a.plan_end} ${pct}%${overdue ? " 【逾期】" : ""}">
            <div class="bar-progress" style="width:${pct}%"></div>
            <span style="position:relative;z-index:1">${pct}%</span>
          </div>`;
        }
        const stCls = doneClass(a.status);
        return `
        <div class="gantt-row ${overdue ? "overdue" : ""}" data-aid="${escapeHtml(a.activity_id)}">
          <div class="act-name" title="${escapeHtml(a.risk_note || "")}"><span class="wbs">${escapeHtml(a.wbs || "")}</span>${escapeHtml(
          a.activity_name
        )}${a.phase ? ` <span class="node-chip" style="font-size:11px;padding:1px 6px">${escapeHtml(a.phase)}</span>` : ""}${a.lead_time_days != null && a.lead_time_days !== "" ? ` <span style="color:var(--muted);font-size:11px">L/T ${escapeHtml(a.lead_time_days)}d</span>` : ""}${overdue ? ' <span class="crit">逾期</span>' : ""}${a.risk_note ? ' <span style="color:var(--warn,#b45309);font-size:11px" title="' + escapeHtml(a.risk_note) + '">⚠</span>' : ""}</div>
          <div><span class="act-status ${stCls}">${escapeHtml(a.status)}</span></div>
          <div><input class="date-input" type="date" data-field="plan_start" value="${escapeHtml(
            a.plan_start || ""
          )}" /></div>
          <div><input class="date-input" type="date" data-field="plan_end" value="${escapeHtml(
            a.plan_end || ""
          )}" /></div>
          <div>
            <div class="timeline" style="--day-w:${dayW}px;width:${timelineW}px">
              ${
                todayOffset >= 0 && todayOffset <= totalDays
                  ? `<div class="today-line" style="left:${todayLeft}px"></div>`
                  : ""
              }
              ${bar}
            </div>
          </div>
        </div>`;
      })
      .join("");

    host.innerHTML = `<div class="gantt-wrap"><div class="gantt" style="--day-w:${dayW}px">${axisHtml}${rowsHtml}</div></div>`;

    host.querySelectorAll(".date-input").forEach((inp) => {
      inp.addEventListener("change", () => {
        const row = inp.closest(".gantt-row");
        const aid = row.dataset.aid;
        const field = inp.dataset.field;
        const val = inp.value;
        if (!overrides[aid]) overrides[aid] = {};
        // seed both from current if first edit
        const base = DATA.activities.find((x) => x.activity_id === aid);
        const cur = getActivity(base);
        overrides[aid].plan_start = field === "plan_start" ? val : cur.plan_start;
        overrides[aid].plan_end = field === "plan_end" ? val : cur.plan_end;
        if (field === "plan_start") overrides[aid].plan_start = val;
        if (field === "plan_end") overrides[aid].plan_end = val;
        saveOverrides();
        // redraw immediately
        const refreshed = DATA.activities
          .filter((a) => a.project_id === projectId)
          .map(getActivity)
          .sort(compareByWbs);
        mountGantt(host, refreshed, projectId);
      });
    });
  }

  function doneClass(status) {
    if (isComplete(status)) return "done";
    if (status === "进行中") return "doing";
    return "todo";
  }

  // ---------- Sub pages ----------
  function projectNav(id, p, active) {
    const links = [
      { key: "detail", label: "甘特详情", href: `#/project/${encodeURIComponent(id)}` },
      { key: "bom", label: "最新BOM", href: `#/project/${encodeURIComponent(id)}/bom` },
      { key: "kit", label: "物料齐套表", href: `#/project/${encodeURIComponent(id)}/kit` },
    ];
    return `
      <div class="toolbar">
        <strong>${escapeHtml(p.project_name)}</strong>
        <span class="spacer"></span>
        ${links
          .map((l) =>
            l.key === active
              ? `<span class="btn sm" style="pointer-events:none">${l.label}</span>`
              : `<a class="btn secondary sm" href="${l.href}">${l.label}</a>`
          )
          .join("")}
        <a class="btn secondary sm" href="#/">← 列表</a>
      </div>`;
  }

  function yn(v) {
    if (v === true || v === "是") return "是";
    if (v === false || v === "否") return "否";
    return escapeHtml(v ?? "");
  }

  function renderBom(id) {
    const p = DATA.projects.find((x) => x.project_id === id);
    if (!p) return miss(id);
    setCrumb([
      { label: "项目列表", href: "#/" },
      { label: p.project_name, href: `#/project/${encodeURIComponent(id)}` },
      { label: "最新BOM" },
    ]);
    const latest = latestBomVersion(id);
    const rows = latestBomRows(id);
    const ver = latest ? latest.version : "—";
    const updated = latest ? latest.updated_at : "—";
    app.innerHTML = `
      <div class="panel">
        ${projectNav(id, p, "bom")}
        <h2>最新BOM</h2>
        <p style="color:var(--muted);font-size:13px;margin-top:-6px">版本 ${escapeHtml(ver)} · 更新于 ${escapeHtml(
      updated
    )} · 仅展示当前项目最新版本（含已替换行）</p>
        <p style="color:var(--muted);font-size:12px;margin:0 0 8px">同料号改量直接更新用量；换料号时旧行标灰且用量为 0，新行紧挨下方；纯新增在清单底部。灰色行为已替换物料。</p>
        ${
          rows.length
            ? `<table class="data">
          <thead><tr>
            <th>物料编码</th><th>物料名称</th><th>物料规格</th><th>用量</th><th>单位</th><th>备注</th>
          </tr></thead>
          <tbody>
            ${rows
              .map((r) => {
                const obsolete = isObsoleteBom(r) || (r.line_status || "") === "已替换";
                const qty = obsolete ? 0 : r.qty_per;
                const note = obsolete
                  ? (r.remark ? escapeHtml(r.remark) + " · " : "") + "已替换"
                  : escapeHtml(r.remark || "");
                return `<tr class="${obsolete ? "row-obsolete" : ""}" data-bom-line-id="${escapeHtml(r.bom_line_id || "")}"${
                  obsolete ? ' style="background:#e2e8f0"' : ""
                }>
              <td${obsolete ? ' style="color:#64748b;text-decoration:line-through;background:#e2e8f0"' : ""}>${escapeHtml(r.material_code)}</td>
              <td${obsolete ? ' style="color:#64748b;text-decoration:line-through;background:#e2e8f0"' : ""}>${escapeHtml(r.material_name)}</td>
              <td${obsolete ? ' style="color:#64748b;text-decoration:line-through;background:#e2e8f0"' : ""}>${escapeHtml(r.spec || "")}</td>
              <td class="num"${obsolete ? ' style="color:#64748b;text-decoration:line-through;background:#e2e8f0"' : ""}>${escapeHtml(qty)}</td>
              <td${obsolete ? ' style="color:#64748b;text-decoration:line-through;background:#e2e8f0"' : ""}>${escapeHtml(r.unit || "")}</td>
              <td${obsolete ? ' style="color:#64748b;background:#e2e8f0"' : ""}>${note}</td>
            </tr>`;
              })
              .join("")}
          </tbody></table>`
            : `<div class="empty-hint">该项目暂无 BOM 数据</div>`
        }
      </div>`;
  }

  function renderKit(id) {
    const p = DATA.projects.find((x) => x.project_id === id);
    if (!p) return miss(id);
    setCrumb([
      { label: "项目列表", href: "#/" },
      { label: p.project_name, href: `#/project/${encodeURIComponent(id)}` },
      { label: "物料齐套表" },
    ]);
    const allRows = DATA.materials.filter((m) => m.project_id === id).map(enrichMaterialRow);
    const rate = kitRate(id);

    app.innerHTML = `
      <div class="panel">
        ${projectNav(id, p, "kit")}
        <h2>物料齐套表 <span style="font-size:13px;font-weight:400;color:var(--muted)">齐套率 ${
          rate == null ? "—" : rate + "%"
        }</span></h2>
        <p style="color:var(--muted);font-size:13px;margin-top:-6px">已合并原「到料状态」「采购回复」；本页仅显示约定字段。</p>
        <div class="toolbar kit-filters">
          <input class="search" id="kitQ" type="search" placeholder="搜索物料编码 / 名称 / 规格…" />
          <select class="filter-select" id="kitStatus">
            <option value="">到料状态：全部</option>
            <option value="已齐套">已齐套</option>
            <option value="缺料">缺料</option>
            <option value="待检验">待检验</option>
            <option value="待入库">待入库</option>
          </select>
          <label class="filter-check"><input type="checkbox" id="kitGapOnly" /> 仅缺口&gt;0</label>
          <span class="spacer"></span>
          <button type="button" class="btn secondary sm" id="btnExportKit">导出</button>
        </div>
        <div id="kitTableHost"></div>
      </div>`;

    const host = document.getElementById("kitTableHost");
    const qEl = document.getElementById("kitQ");
    const stEl = document.getElementById("kitStatus");
    const gapEl = document.getElementById("kitGapOnly");
    const btnExport = document.getElementById("btnExportKit");

    let filtered = allRows.slice();

    function paint() {
      const q = (qEl.value || "").trim().toLowerCase();
      const st = stEl.value;
      const gapOnly = gapEl.checked;
      filtered = allRows.filter((r) => {
        if (st && r.arrival_status !== st) return false;
        if (gapOnly && !(Number(r.qty_gap) > 0)) return false;
        if (!q) return true;
        const blob = [r.material_code, r.material_name, r.spec, r.material_line_id].join(" ").toLowerCase();
        return blob.includes(q);
      });
      host.innerHTML = tableMergedKit(filtered, id);
    }

    qEl.addEventListener("input", paint);
    stEl.addEventListener("change", paint);
    gapEl.addEventListener("change", paint);
    btnExport.addEventListener("click", () => exportKitCsv(filtered, id));
    paint();
  }

  function tableMergedKit(rows, projectId) {
    if (!rows.length) return `<div class="empty-hint">无匹配物料</div>`;
    return `<div class="table-scroll"><table class="data kit-merged">
      <thead><tr>
        <th class="col-code">物料编码</th><th class="col-name">物料名称</th><th>物料规格</th><th>需求数量</th>
        <th>淄博库存</th><th>天津库存</th><th>北京库存</th>
        <th>采购订单数量</th><th>采购申请数量</th><th>收货单数量</th>
        <th>待入库数量</th><th>待检验数量</th><th>缺口数量</th>
        <th class="col-need">需求日期</th><th class="col-commit">交期回复</th><th>到料状态</th><th>备注</th>
      </tr></thead>
      <tbody>
        ${rows
          .map((r) => {
            const gap = Number(r.qty_gap) || 0;
            const commit = getCommitDate(r) || r.commit_date || "";
            const status = r.arrival_status || computeArrivalStatus(r);
            return `<tr data-material-line-id="${escapeHtml(r.material_line_id || "")}">
            <td class="col-code">${escapeHtml(r.material_code)}</td>
            <td class="col-name">${escapeHtml(r.material_name)}</td>
            <td>${escapeHtml(r.spec || "")}</td>
            <td class="num">${escapeHtml(r.qty_required)}</td>
            <td class="num">${escapeHtml(r.qty_stock_zibo ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_stock_tianjin ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_stock_beijing ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_po ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_pr ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_received ?? r.qty_received_doc ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_pending_inbound ?? "")}</td>
            <td class="num">${escapeHtml(r.qty_pending_inspect ?? "")}</td>
            <td class="num ${gap > 0 ? "crit" : ""}">${gap}</td>
            <td class="col-need">${escapeHtml(r.need_date || "")}</td>
            <td class="col-commit">${escapeHtml(commit)}</td>
            <td class="col-status"><span class="tag tag-${escapeHtml(status)}">${escapeHtml(status)}</span></td>
            <td class="col-remark">${escapeHtml(r.remark || "")}</td>
          </tr>`;
          })
          .join("")}
      </tbody></table></div>`;
  }

  function exportKitCsv(rows, projectId) {
    const headers = [
      "物料编码",
      "物料名称",
      "物料规格",
      "需求数量",
      "淄博库存",
      "天津库存",
      "北京库存",
      "采购订单数量",
      "采购申请数量",
      "收货单数量",
      "待入库数量",
      "待检验数量",
      "缺口数量",
      "需求日期",
      "交期回复",
      "到料状态",
      "备注",
    ];
    const lines = [headers.join(",")];
    rows.forEach((r) => {
      const status = r.arrival_status || computeArrivalStatus(r);
      const commit = getCommitDate(r) || r.commit_date || "";
      const vals = [
        r.material_code,
        r.material_name,
        r.spec || "",
        r.qty_required,
        r.qty_stock_zibo,
        r.qty_stock_tianjin,
        r.qty_stock_beijing,
        r.qty_po,
        r.qty_pr,
        r.qty_received ?? r.qty_received_doc,
        r.qty_pending_inbound,
        r.qty_pending_inspect,
        r.qty_gap,
        r.need_date,
        commit,
        status,
        r.remark || "",
      ].map((v) => {
        const s = v == null ? "" : String(v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      });
      lines.push(vals.join(","));
    });
    const bom = "\uFEFF" + lines.join("\n");
    const blob = new Blob([bom], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const d = todayStr().replace(/-/g, "");
    a.href = URL.createObjectURL(blob);
    a.download = `物料齐套_${projectId}_${d}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
    showToast("已导出 " + rows.length + " 行");
  }

  function miss(id) {
    app.innerHTML = `<div class="error">未找到项目 ${escapeHtml(id)}</div>`;
  }

  function render() {
    if (!DATA) return;
    todayLabel.textContent = `今日 ${todayStr()}`;
    const route = parseRoute();
    if (route.page === "list") return renderList();
    if (route.page === "project") {
      if (route.sub === "bom") return renderBom(route.id);
      if (route.sub === "kit" || route.sub === "arrival" || route.sub === "purchase") {
        if (route.sub === "arrival" || route.sub === "purchase") {
          // redirect old hash routes to merged kit page
          location.hash = `#/project/${encodeURIComponent(route.id)}/kit`;
          return;
        }
        return renderKit(route.id);
      }
      return renderProjectDetail(route.id);
    }
    renderList();
  }

  function showToast(msg) {
    const el = document.getElementById("toast");
    if (!el) {
      console.log(msg);
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => {
        el.hidden = true;
      }, 200);
    }, 2600);
  }

  function clearDateOverrides() {
    localStorage.removeItem(LS_KEY);
    overrides = {};
  }

  async function applyData(next, toastMsg) {
    DATA = next;
    clearDateOverrides();
    try { localStorage.removeItem("rd-plan-board-commit-v1"); } catch (_) {}
    normalizeImportedBom(DATA.bom || []);
    enrichImportedMaterials(DATA);
    render();
    if (toastMsg) showToast(toastMsg);
  }

  function normalizeImportedBom(bom) {
    const byId = Object.fromEntries((bom || []).filter((b) => b.bom_line_id).map((b) => [b.bom_line_id, b]));
    (bom || []).forEach((b) => {
      if (!b.line_status) {
        b.line_status = b.replaced_by_line_id ? "已替换" : "有效";
      }
      if (!b.change_type) {
        if (b.replaces_line_id) b.change_type = "替换";
        else if (b.line_status === "已替换") b.change_type = "替换";
        else b.change_type = "无";
      }
      if (b.line_status === "已替换") b.qty_per = 0;
      const rid = b.replaces_line_id;
      if (rid && byId[rid]) {
        const old = byId[rid];
        if (!old.replaced_by_line_id) old.replaced_by_line_id = b.bom_line_id;
        old.line_status = "已替换";
        old.qty_per = 0;
        if (!old.change_type) old.change_type = "替换";
      }
    });
  }

  function enrichImportedMaterials(data) {
    const mats = data.materials || [];
    const replies = data.purchase_replies || [];
    const specByCode = {};
    (data.bom || []).forEach((b) => {
      if (b.material_code && b.spec && specByCode[b.material_code] == null) specByCode[b.material_code] = b.spec;
    });
    mats.forEach((m) => {
      if (!m.spec && specByCode[m.material_code]) m.spec = specByCode[m.material_code];
      const stock = sumStock(m);
      m.qty_stock = stock;
      // 收货单数量 → qty_received (fallback legacy qty_received_doc)
      if (
        (m.qty_received === null || m.qty_received === undefined || m.qty_received === "") &&
        m.qty_received_doc != null &&
        m.qty_received_doc !== ""
      ) {
        m.qty_received = m.qty_received_doc;
      }
      if (m.qty_gap === null || m.qty_gap === undefined || m.qty_gap === "") {
        m.qty_gap = Math.max(0, numOr0(m.qty_required) - stock - numOr0(m.qty_in_transit));
      }
      if (!m.commit_date) {
        const hit =
          replies.find((r) => r.material_line_id && r.material_line_id === m.material_line_id) ||
          replies
            .filter((r) => r.project_id === m.project_id && r.material_code === m.material_code)
            .sort((a, b) => String(b.reply_date || "").localeCompare(String(a.reply_date || "")))[0];
        if (hit && hit.commit_date) m.commit_date = hit.commit_date;
      }
      if (!m.arrival_status) m.arrival_status = computeArrivalStatus(m);
    });
  }

  async function loadJson(bustCache) {
    const url = bustCache ? DATA_URL + "?t=" + Date.now() : DATA_URL;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- Excel import (SheetJS) ----------
  const SHEET_MAP = {
    项目: "projects",
    计划活动: "activities",
    BOM: "bom",
    物料齐套: "materials",
    采购回复: "purchase_replies",
    异常: "issues",
  };

  const BOOL_FIELDS = new Set([
    "is_milestone",
    "is_critical",
    "impact_kit",
    "impact_schedule",
    "rd_stock_flag",
    "mp_stock_flag",
    "rd_shared",
    "mp_shared",
  ]);
  const NUMBER_FIELDS = new Set([
    "target_qty",
    "progress_pct",
    "qty_per",
    "qty_required",
    "qty_stock",
    "qty_stock_zibo",
    "qty_stock_tianjin",
    "qty_stock_beijing",
    "qty_in_transit",
    "qty_received",
    "qty_gap",
    "commit_qty",
    "lead_time_days",
    "moq",
    "qty_po",
    "qty_pr",
    "qty_received_doc",
    "qty_pending_inbound",
    "qty_pending_inspect",
  ]);
  const DATE_FIELDS = new Set([
    "plan_start",
    "plan_end",
    "actual_start",
    "actual_end",
    "bom_updated_at",
    "need_date",
    "eta_date",
    "reply_date",
    "commit_date",
    "updated_at",
    "opened_at",
    "due_at",
  ]);

  function excelEmpty(v) {
    return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
  }

  function excelBool(v) {
    if (typeof v === "boolean") return v;
    if (excelEmpty(v)) return false;
    const s = String(v).trim().toLowerCase();
    if (["是", "yes", "y", "true", "1", "真"].includes(s)) return true;
    if (["否", "no", "n", "false", "0", "假", ""].includes(s)) return false;
    return Boolean(v);
  }

  function excelNumber(v) {
    if (excelEmpty(v)) return null;
    if (typeof v === "number") return Number.isInteger(v) ? v : v;
    const s = String(v).trim().replace(/,/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : v;
  }

  function excelDate(v) {
    if (excelEmpty(v)) return "";
    if (v instanceof Date && !isNaN(v.getTime())) {
      const y = v.getFullYear();
      const m = String(v.getMonth() + 1).padStart(2, "0");
      const d = String(v.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    if (typeof v === "number" && typeof XLSX !== "undefined" && XLSX.SSF) {
      try {
        const parsed = XLSX.SSF.parse_date_code(v);
        if (parsed) {
          const y = parsed.y;
          const m = String(parsed.m).padStart(2, "0");
          const d = String(parsed.d).padStart(2, "0");
          return `${y}-${m}-${d}`;
        }
      } catch (_) {}
    }
    const s = String(v).trim();
    if (!s) return "";
    const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (m) {
      return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    }
    return s;
  }

  function coerceExcel(key, v) {
    if (BOOL_FIELDS.has(key)) return excelBool(v);
    if (NUMBER_FIELDS.has(key)) return excelNumber(v);
    if (DATE_FIELDS.has(key)) return excelDate(v);
    if (excelEmpty(v)) return "";
    if (v instanceof Date) return excelDate(v);
    return typeof v === "string" ? v.trim() : v;
  }

  function parseSheetAOA(aoa) {
    if (!aoa || aoa.length < 2) return [];
    const keys = (aoa[1] || []).map((k) => (excelEmpty(k) ? null : String(k).trim()));
    const rows = [];
    for (let r = 2; r < aoa.length; r++) {
      const line = aoa[r] || [];
      const allEmpty = keys.every((_, i) => excelEmpty(line[i]));
      if (allEmpty) continue;
      const obj = {};
      keys.forEach((key, i) => {
        if (!key) return;
        obj[key] = coerceExcel(key, line[i]);
      });
      const idKeys = [
        "project_id",
        "activity_id",
        "bom_line_id",
        "material_line_id",
        "reply_id",
        "issue_id",
      ];
      const hasId = idKeys.some((k) => obj[k] !== undefined && obj[k] !== "" && obj[k] !== null);
      const hasAny = Object.values(obj).some((v) => v !== "" && v !== null && v !== undefined);
      if (!hasId && !hasAny) continue;
      rows.push(obj);
    }
    return rows;
  }

  function computeGaps(materials) {
    materials.forEach((m) => {
      const stock = sumStock(m);
      m.qty_stock = stock;
      if (m.qty_gap === null || m.qty_gap === undefined || m.qty_gap === "") {
        const req = Number(m.qty_required) || 0;
        const transit = Number(m.qty_in_transit) || 0;
        m.qty_gap = Math.max(0, req - stock - transit);
      }
    });
  }

  function todayLocalISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseExcelWorkbook(wb) {
    const parts = {
      projects: [],
      activities: [],
      bom: [],
      materials: [],
      purchase_replies: [],
      issues: [],
    };
    Object.keys(SHEET_MAP).forEach((sheetName) => {
      const jsonKey = SHEET_MAP[sheetName];
      if (!wb.SheetNames.includes(sheetName)) return;
      const ws = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json(ws, {
        header: 1,
        defval: null,
        raw: true,
      });
      parts[jsonKey] = parseSheetAOA(aoa);
    });
    computeGaps(parts.materials);
    const payload = {
      meta: {
        title: "研发生产计划看板",
        generated_at: new Date().toISOString(),
        today: todayLocalISO(),
        kit_formula: "qty_gap = max(0, qty_required - qty_stock - qty_in_transit); qty_stock = zibo+tianjin+beijing",
        overdue_rule: "status != 已完成 AND plan_end < today",
        bom_latest_rule: "per project_id: max bom_version (string), tie-break max bom_updated_at",
        arrival_status_rule: "待检验 > 待入库 > 已齐套 > 缺料",
      },
      ...parts,
    };
    normalizeImportedBom(payload.bom);
    enrichImportedMaterials(payload);
    return payload;
  }

  async function importExcelFile(file) {
    if (typeof XLSX === "undefined") {
      throw new Error("SheetJS (XLSX) 未加载，请检查 CDN");
    }
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    return parseExcelWorkbook(wb);
  }

  function wireImportUi() {
    const btnImport = document.getElementById("btnImportExcel");
    const fileInput = document.getElementById("fileExcel");
    const btnReload = document.getElementById("btnReloadJson");

    if (btnImport && fileInput) {
      btnImport.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", async () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        try {
          const next = await importExcelFile(file);
          await applyData(next, "已导入，页面已刷新");
        } catch (e) {
          showToast("导入失败：" + (e && e.message ? e.message : String(e)));
          console.error(e);
        }
      });
    }

    if (btnReload) {
      btnReload.addEventListener("click", async () => {
        try {
          const next = await loadJson(true);
          await applyData(next, "已重新加载 JSON");
        } catch (e) {
          showToast("重新加载失败：" + (e && e.message ? e.message : String(e)));
          console.error(e);
        }
      });
    }
  }

  async function boot() {
    wireImportUi();
    try {
      DATA = await loadJson(true);
      normalizeImportedBom(DATA.bom || []);
      enrichImportedMaterials(DATA);
      // Drop legacy commit drafts; 交期仅展示 sample-data.json（Excel 同步）
      try { localStorage.removeItem("rd-plan-board-commit-v1"); } catch (_) {}
      render();
    } catch (e) {
      app.innerHTML = `<div class="error">
        无法加载 sample-data.json。<br/>
        请在项目根目录运行：<br/>
        <code>python server.py</code><br/>
        或双击 <code>启动看板.bat</code>，然后打开 <code>http://127.0.0.1:9888/web/</code><br/>
        <small>${escapeHtml(e.message)}</small>
      </div>`;
    }
  }

  boot();
})();

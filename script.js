const API_URL = '/api';

const supportForm = document.getElementById("supportForm");
const message = document.getElementById("message");
const ticketTable = document.getElementById("ticketTable");
const searchTicket = document.getElementById("searchTicket");

const filterStatus = document.getElementById("filterStatus");
const filterPriority = document.getElementById("filterPriority");
const filterDepartment = document.getElementById("filterDepartment");
const clearFiltersBtn = document.getElementById("clearFilters");

const exportCSVBtn = document.getElementById("exportCSV");
let deptChartInstance = null;
let priorityChartInstance = null;

const loginSection = document.getElementById("loginSection");
const appContainer = document.getElementById("appContainer");
const authForm = document.getElementById("authForm");
const authTitle = document.getElementById("authTitle");
const authSubmit = document.getElementById("authSubmit");
const authToggle = document.getElementById("authToggle");
const nameGroup = document.getElementById("nameGroup");
const roleGroup = document.getElementById("roleGroup");
const userDisplay = document.getElementById("userDisplay");
const logoutBtn = document.getElementById("logoutBtn");

let tickets = [];
let currentUser = null;
let isLoginMode = true;
let authToken = localStorage.getItem("token") || null;

const STATUS_FLOW = ["Open", "In Progress", "Resolved"];

async function apiGet(path) {
  const res = await fetch(API_URL + path, {
    headers: { 'Authorization': 'Bearer ' + authToken }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(API_URL + path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + authToken
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(API_URL + path, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + authToken }
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function decodeToken(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]));
  } catch {
    return null;
  }
}

function getPriorityClass(priority) {
  return priority.toLowerCase();
}

function getStatusClass(status) {
  if (status === "In Progress") return "in-progress";
  return status.toLowerCase();
}

function displayTickets(ticketList = tickets) {
  ticketTable.innerHTML = "";

  if (ticketList.length === 0) {
    ticketTable.innerHTML = `
      <tr>
        <td colspan="8" style="text-align:center; color:#64748b;">
          No support tickets found.
        </td>
      </tr>
    `;
    return;
  }

  const isAdmin = currentUser && currentUser.role === "Admin";

  ticketList.forEach(function(ticket) {
    const row = document.createElement("tr");

    const statusAttrs = isAdmin
      ? `onclick="cycleStatus('${ticket.id}')" title="Click to change status" style="cursor:pointer;"`
      : '';

    const deleteBtn = isAdmin
      ? `<button class="action-btn delete-btn" onclick="deleteTicket('${ticket.id}')">Delete</button>`
      : '';

    row.innerHTML = `
      <td><strong>${ticket.id}</strong></td>
      <td>${ticket.name}</td>
      <td>${ticket.department}</td>
      <td>${ticket.problem}</td>
      <td>
        <span class="priority-badge ${getPriorityClass(ticket.priority)}">
          ${ticket.priority}
        </span>
      </td>
      <td>${ticket.date}</td>
      <td>
        <span class="status ${getStatusClass(ticket.status)}" ${statusAttrs}>
          ${ticket.status}
        </span>
      </td>
      <td>${deleteBtn}</td>
    `;

    ticketTable.appendChild(row);
  });
}

function applyFilters() {
  const searchValue = searchTicket.value.toLowerCase();
  const statusValue = filterStatus.value;
  const priorityValue = filterPriority.value;
  const deptValue = filterDepartment.value;

  const filtered = tickets.filter(function(ticket) {
    const matchesSearch = !searchValue || (
      ticket.id.toLowerCase().includes(searchValue) ||
      ticket.name.toLowerCase().includes(searchValue) ||
      ticket.department.toLowerCase().includes(searchValue) ||
      ticket.problem.toLowerCase().includes(searchValue) ||
      ticket.priority.toLowerCase().includes(searchValue) ||
      ticket.status.toLowerCase().includes(searchValue)
    );
    const matchesStatus = !statusValue || ticket.status === statusValue;
    const matchesPriority = !priorityValue || ticket.priority === priorityValue;
    const matchesDept = !deptValue || ticket.department === deptValue;

    return matchesSearch && matchesStatus && matchesPriority && matchesDept;
  });

  displayTickets(filtered);
}

async function cycleStatus(ticketId) {
  if (!currentUser || currentUser.role !== "Admin") return;

  const ticket = tickets.find(function(t) { return t.id === ticketId; });
  if (!ticket) return;

  const currentIndex = STATUS_FLOW.indexOf(ticket.status);
  const nextIndex = (currentIndex + 1) % STATUS_FLOW.length;
  const newStatus = STATUS_FLOW[nextIndex];

  try {
    await apiPut('/tickets/' + ticketId + '/status', { status: newStatus });
    ticket.status = newStatus;
    if (newStatus === "Resolved") ticket.resolvedAt = Date.now();
    applyFilters();
    updateDashboard();
    updateAdminDashboard();
  } catch (err) {
    alert("Error updating status: " + err.message);
  }
}

async function deleteTicket(ticketId) {
  if (!currentUser || currentUser.role !== "Admin") return;
  if (!confirm("Are you sure you want to delete this ticket?")) return;

  try {
    await apiDelete('/tickets/' + ticketId);
    tickets = tickets.filter(function(t) { return t.id !== ticketId; });
    applyFilters();
    updateDashboard();
    updateAdminDashboard();
  } catch (err) {
    alert("Error deleting: " + err.message);
  }
}

function updateDashboard() {
  document.getElementById("totalTickets").textContent = tickets.length;
  const openTickets = tickets.filter(function(t) { return t.status === "Open"; });
  document.getElementById("openTickets").textContent = openTickets.length;
  const highTickets = tickets.filter(function(t) { return t.priority === "High"; });
  document.getElementById("highTickets").textContent = highTickets.length;
  const resolvedTickets = tickets.filter(function(t) { return t.status === "Resolved"; });
  document.getElementById("resolvedTickets").textContent = resolvedTickets.length;
}

supportForm.addEventListener("submit", async function(event) {
  event.preventDefault();

  const name = document.getElementById("name").value;
  const department = document.getElementById("department").value;
  const problem = document.getElementById("problem").value;
  const priority = document.querySelector('input[name="priority"]:checked').value;

  try {
    const ticket = await apiPost('/tickets', {
      name: name,
      department: department,
      problem: problem,
      priority: priority,
      date: new Date().toLocaleString()
    });

    tickets.unshift(ticket);
    applyFilters();
    updateDashboard();
    updateAdminDashboard();

    message.innerHTML = `
      <div class="success-message">
        <strong>Ticket submitted successfully!</strong><br><br>
        Ticket Number: <strong>${ticket.id}</strong>
      </div>
    `;

    supportForm.reset();
    if (currentUser) {
      document.getElementById("name").value = currentUser.name;
    }
  } catch (err) {
    alert("Error submitting ticket: " + err.message);
  }
});

searchTicket.addEventListener("input", applyFilters);
filterStatus.addEventListener("change", applyFilters);
filterPriority.addEventListener("change", applyFilters);
filterDepartment.addEventListener("change", applyFilters);

clearFiltersBtn.addEventListener("click", function() {
  searchTicket.value = "";
  filterStatus.value = "";
  filterPriority.value = "";
  filterDepartment.value = "";
  applyFilters();
});

function toggleAuthMode() {
  isLoginMode = !isLoginMode;
  if (isLoginMode) {
    authTitle.textContent = "Login";
    authSubmit.textContent = "Login";
    authToggle.innerHTML = 'Don\'t have an account? <a href="#">Register</a>';
    nameGroup.style.display = "none";
    roleGroup.style.display = "none";
  } else {
    authTitle.textContent = "Register";
    authSubmit.textContent = "Register";
    authToggle.innerHTML = 'Already have an account? <a href="#">Login</a>';
    nameGroup.style.display = "block";
    roleGroup.style.display = "block";
  }
}

authToggle.addEventListener("click", function(e) {
  e.preventDefault();
  toggleAuthMode();
});

authForm.addEventListener("submit", async function(e) {
  e.preventDefault();
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;

  try {
    let data;
    if (isLoginMode) {
      data = await apiPost('/auth/login', { email, password });
    } else {
      const name = document.getElementById("authName").value.trim();
      if (!name) { alert("Please enter your full name"); return; }
      data = await apiPost('/auth/register', { name, email, password });
    }

    authToken = data.token;
    localStorage.setItem("token", authToken);
    currentUser = data.user;
    showApp();
  } catch (err) {
    alert(err.message.replace(/^"|"$/g, ''));
  }
});

logoutBtn.addEventListener("click", function() {
  authToken = null;
  currentUser = null;
  tickets = [];
  localStorage.removeItem("token");
  showLogin();
});

function showLogin() {
  loginSection.style.display = "flex";
  appContainer.style.display = "none";
  userInfo.style.display = "none";
  supportForm.reset();
  message.innerHTML = "";
}

async function showApp() {
  loginSection.style.display = "none";
  appContainer.style.display = "block";
  userInfo.style.display = "flex";

  userDisplay.textContent = `${currentUser.name} (${currentUser.role})`;
  document.getElementById("userAvatar").textContent = (currentUser.name || "U")
    .split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
  document.getElementById("name").value = currentUser.name;

  const adminSection = document.getElementById("adminSection");
  if (currentUser.role === "Admin") {
    if (adminSection) adminSection.style.display = "block";
    if (exportCSVBtn) exportCSVBtn.style.display = "inline-block";
  } else {
    if (adminSection) adminSection.style.display = "none";
    if (exportCSVBtn) exportCSVBtn.style.display = "none";
  }

  try {
    tickets = await apiGet('/tickets');
  } catch (err) {
    alert("Failed to load tickets: " + err.message);
    tickets = [];
  }

  applyFilters();
  updateDashboard();
  updateAdminDashboard();
}

function countByDepartment() {
  const counts = {};
  tickets.forEach(function(t) {
    counts[t.department] = (counts[t.department] || 0) + 1;
  });
  return counts;
}

function countByPriority() {
  const counts = {};
  tickets.forEach(function(t) {
    counts[t.priority] = (counts[t.priority] || 0) + 1;
  });
  return counts;
}

function calculateAvgResolutionTime() {
  const resolved = tickets.filter(function(t) {
    return t.status === "Resolved" && t.resolvedAt;
  });
  if (resolved.length === 0) return null;
  let totalHours = 0;
  resolved.forEach(function(t) {
    const created = t.createdAt || parseInt(t.id.replace("TKT-", ""));
    const diffMs = t.resolvedAt - created;
    totalHours += diffMs / (1000 * 60 * 60);
  });
  return (totalHours / resolved.length).toFixed(1);
}

function renderBreakdowns() {
  const deptCounts = countByDepartment();
  const deptContainer = document.getElementById("deptStats");
  deptContainer.innerHTML = "";
  Object.entries(deptCounts).forEach(function([dept, count]) {
    deptContainer.innerHTML += `
      <div class="breakdown-row">
        <span>${dept}</span>
        <span class="breakdown-count">${count}</span>
      </div>
    `;
  });

  const priorityCounts = countByPriority();
  const priorityContainer = document.getElementById("priorityStats");
  priorityContainer.innerHTML = "";
  Object.entries(priorityCounts).forEach(function([priority, count]) {
    priorityContainer.innerHTML += `
      <div class="breakdown-row">
        <span class="priority-badge ${priority.toLowerCase()}">${priority}</span>
        <span class="breakdown-count">${count}</span>
      </div>
    `;
  });

  const avgTime = calculateAvgResolutionTime();
  document.getElementById("avgResolutionTime").textContent =
    avgTime ? avgTime + " hours" : "No resolved tickets";
}

function renderCharts() {
  const deptCounts = countByDepartment();
  const priorityCounts = countByPriority();

  if (deptChartInstance) deptChartInstance.destroy();
  if (priorityChartInstance) priorityChartInstance.destroy();

  const deptCtx = document.getElementById("deptChart").getContext("2d");
  deptChartInstance = new Chart(deptCtx, {
    type: 'bar',
    data: {
      labels: Object.keys(deptCounts),
      datasets: [{
        label: 'Tickets',
        data: Object.values(deptCounts),
        backgroundColor: '#2563eb',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } }
      }
    }
  });

  const priorityColors = { Low: '#dcfce7', Medium: '#fef3c7', High: '#fee2e2' };

  const priorityCtx = document.getElementById("priorityChart").getContext("2d");
  priorityChartInstance = new Chart(priorityCtx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(priorityCounts),
      datasets: [{
        data: Object.values(priorityCounts),
        backgroundColor: Object.keys(priorityCounts).map(function(p) {
          return priorityColors[p] || '#cbd5e1';
        }),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%'
    }
  });
}

function renderRecentActivity() {
  const recentList = document.getElementById("recentList");
  recentList.innerHTML = "";
  const recent = tickets.slice(0, 5);
  if (recent.length === 0) {
    recentList.innerHTML = "<li>No recent activity</li>";
    return;
  }
  recent.forEach(function(t) {
    recentList.innerHTML += `
      <li>
        <span>
          <strong>${t.id}</strong> — ${t.name} (${t.department})
        </span>
        <span class="activity-time">${t.date}</span>
      </li>
    `;
  });
}

function updateAdminDashboard() {
  if (!currentUser || currentUser.role !== "Admin") return;
  renderBreakdowns();
  renderCharts();
  renderRecentActivity();
}

function exportToCSV() {
  if (!currentUser || currentUser.role !== "Admin") return;
  if (tickets.length === 0) { alert("No tickets to export."); return; }

  const headers = ["Ticket ID", "Name", "Department", "Problem", "Priority", "Date", "Status"];
  const rows = tickets.map(function(t) {
    return [
      t.id,
      '"' + t.name.replace(/"/g, '""') + '"',
      t.department,
      '"' + t.problem.replace(/"/g, '""') + '"',
      t.priority,
      t.date,
      t.status
    ];
  });

  const csv = [headers.join(","), rows.map(function(r) { return r.join(","); }).join("\n")].join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "support_tickets.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

exportCSVBtn.addEventListener("click", exportToCSV);

if (authToken) {
  const decoded = decodeToken(authToken);
  if (decoded && decoded.exp * 1000 > Date.now()) {
    currentUser = { name: decoded.name, email: decoded.email, role: decoded.role };
    showApp();
  } else {
    localStorage.removeItem("token");
    showLogin();
  }
} else {
  showLogin();
}
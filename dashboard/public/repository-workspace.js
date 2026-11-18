import { fetchJson, openWorkspaceSection } from "./app.js";

const wizardPanel = document.querySelector("#repository-onboarding-chat");
const wizardForm = document.querySelector("#repository-onboarding-form");
const wizardAnswer = document.querySelector("#repository-onboarding-answer");
const wizardMessages = document.querySelector("#repository-onboarding-messages");
const wizardMessage = document.querySelector("#repository-onboarding-message");
const suggested = document.querySelector("#repository-onboarding-suggested");
const wizardApply = document.querySelector("#repository-onboarding-apply");
const wizardOpen = document.querySelector("#repository-onboarding-open");
const settingsForm = document.querySelector("#repository-settings-form");
const settingsFields = document.querySelector("#repository-settings-fields");
const settingsMessage = document.querySelector("#repository-settings-message");
const settingsApply = document.querySelector("#repository-settings-apply");
let wizard = null;
let settings = null;

const linkedLoad = document.querySelector("#linked-applications-load");
const linkedList = document.querySelector("#linked-applications-list");
const linkedMessage = document.querySelector("#linked-applications-message");
let linkedContext = null;

async function openLinkedApplication(link, context, button) {
  if (linkedContext !== context ||
      !window.confirm(`Open ${link.id} in its own FixLab workspace?\nRepository: ${link.repository}\nApplication: ${link.url}\nNo application or job will be started.`)) {
    return;
  }
  button.disabled = true;
  try {
    const result = await configurationRequest(context, {
      action: "open-linked-application", applicationId: link.id,
      revision: link.revision, confirmed: true
    });
    if (linkedContext !== context) { return; }
    const url = new URL(result.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("The linked repository returned an invalid local workspace URL.");
    }
    window.location.assign(url.href);
  } catch (error) {
    linkedMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

linkedLoad.addEventListener("click", async () => {
  linkedLoad.disabled = true;
  linkedContext = null;
  linkedList.replaceChildren();
  linkedMessage.textContent = "";
  try {
    const context = await fetchJson("/api/linked-applications");
    linkedContext = context;
    linkedMessage.textContent = context.applications.length ? context.notice : "No linked applications are configured.";
    for (const link of context.applications) {
      const article = document.createElement("article");
      const description = document.createElement("p");
      description.textContent = `${link.id}: ${link.url} - ${link.repository}`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Open ${link.id} workspace`;
      button.dataset.linkedApplicationId = link.id;
      article.append(description, button);
      linkedList.append(article);
    }
  } catch (error) {
    linkedMessage.textContent = error.message;
  } finally {
    linkedLoad.disabled = false;
  }
});

linkedList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) { return; }
  const button = event.target.closest("button[data-linked-application-id]");
  if (!button || !linkedList.contains(button)) { return; }
  const link = linkedContext?.applications.find((entry) => entry.id === button.dataset.linkedApplicationId);
  if (link) { void openLinkedApplication(link, linkedContext, button); }
});

function configurationRequest(context, body) {
  return fetchJson("/api/repository/configuration", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, instanceId: context.instanceId })
  });
}

function appendMessage(role, text) {
  const article = document.createElement("article");
  article.className = `chat-message ${role === "You" ? "user-message" : "assistant-message"}`;
  const name = document.createElement("strong");
  name.textContent = role;
  const message = document.createElement("p");
  message.textContent = text;
  article.append(name, message);
  wizardMessages.append(article);
}

function wizardBusy(busy) {
  wizardForm.querySelectorAll("button, input").forEach((element) => { element.disabled = busy; });
}

function displayPlan(target, plan) {
  document.querySelector(target).textContent =
    `${plan.notice}\n\nRepository: ${plan.repository}\nFiles:\n${plan.files.join("\n")}\n\nSettings:\n${JSON.stringify(plan.values, null, 2)}`;
}

async function loadConfiguration(repository) {
  const status = await fetchJson("/api/status");
  const context = { instanceId: status.instanceId };
  return { ...await configurationRequest(context, {
    action: "inspect", ...(repository === undefined ? {} : { repository })
  }), instanceId: context.instanceId };
}

function question() {
  while (wizard.index < wizard.fields.length) {
    const field = wizard.fields[wizard.index];
    if ((!field.when || wizard.values[field.when]) && (!field.unless || !wizard.values[field.unless])) {
      const value = wizard.values[field.key];
      const hint = field.type === "boolean" ? (value ? "yes" : "no") : String(value);
      appendMessage("FixLab", `${field.label}${hint ? ` Suggested: ${hint}` : ""}`);
      document.querySelector("#repository-onboarding-label").textContent = field.label;
      wizardAnswer.value = "";
      wizardAnswer.placeholder = hint;
      suggested.hidden = !hint;
      wizardAnswer.focus();
      return;
    }
    wizard.index++;
  }
  void previewWizard();
}

async function previewWizard() {
  const current = wizard;
  wizardBusy(true);
  try {
    const plan = await configurationRequest(current, {
      action: "preview", repository: current.repository, revision: current.revision,
      values: current.values, install: true
    });
    if (wizard !== current) { return; }
    current.plan = plan;
    wizardForm.hidden = true;
    displayPlan("#repository-onboarding-plan", plan);
    document.querySelector("#repository-onboarding-review").hidden = false;
    appendMessage("FixLab", "Review the proposed configuration and listed files. Applying this plan does not install dependencies, sign in, run commands or start a job.");
  } catch (error) {
    if (wizard === current) {
      wizardMessage.textContent = error.message;
      current.index = 0;
      appendMessage("FixLab", "The plan was not applied. Correct the answers; existing files and running jobs are unchanged.");
      question();
    }
  } finally {
    if (wizard === current) { wizardBusy(false); }
  }
}

document.querySelector("#add-local-repository").addEventListener("click", () => {
  wizard = { index: -1, fields: [], values: {} };
  wizardMessages.replaceChildren();
  wizardMessage.textContent = "";
  wizardAnswer.value = "";
  wizardAnswer.placeholder = "Absolute path to an existing local Git working tree";
  document.querySelector("#repository-onboarding-label").textContent = "Local repository folder";
  wizardForm.hidden = false;
  suggested.hidden = true;
  wizardApply.disabled = false;
  document.querySelector("#repository-onboarding-reload").disabled = false;
  wizardOpen.hidden = true;
  wizardOpen.disabled = false;
  document.querySelector("#repository-onboarding-review").hidden = true;
  wizardPanel.hidden = false;
  wizardBusy(false);
  appendMessage("FixLab", "Which existing local Git repository would you like to set up? Paste its absolute root folder path. I will not clone a repository or scan your other folders.");
  openWorkspaceSection("repository-onboarding-chat");
  wizardAnswer.focus();
});
document.querySelector("#repository-onboarding-close").addEventListener("click", () => {
  wizard = null;
  wizardPanel.hidden = true;
});
suggested.addEventListener("click", () => {
  if (!wizard || wizard.index < 0) { return; }
  const field = wizard.fields[wizard.index];
  wizardAnswer.value = field.type === "boolean" ? (wizard.values[field.key] ? "yes" : "no") : String(wizard.values[field.key]);
  wizardForm.requestSubmit();
});
wizardForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const current = wizard;
  if (!current) { return; }
  wizardMessage.textContent = "";
  try {
    if (current.index === -1) {
      const path = wizardAnswer.value.trim();
      wizardBusy(true);
      const configuration = await loadConfiguration(path);
      if (wizard !== current) { return; }
      Object.assign(current, configuration, { index: 0 });
      appendMessage("You", configuration.repository);
      appendMessage("FixLab", configuration.exists
        ? "This repository already has a profile. Existing custom settings and scaffolding will be preserved unless you explicitly change the displayed fields."
        : "Let's configure its applications and browser checks. Missing prerequisites will still need their normal setup or sign-in.");
    } else {
      const field = current.fields[current.index];
      const text = wizardAnswer.value.trim();
      const value = field.type === "number" ? Number(text) : field.type === "boolean"
        ? (/^yes$/i.test(text) ? true : /^no$/i.test(text) ? false : undefined) : text;
      if (value === undefined || (field.type === "number" && (!Number.isInteger(value) || value < 1 || value > field.max)) ||
          (field.type === "text" && !text && !field.optional)) {
        throw new Error(field.type === "boolean" ? "Answer yes or no." : "Enter a valid value or use the suggested answer.");
      }
      current.values[field.key] = value;
      appendMessage("You", field.type === "boolean" ? (value ? "yes" : "no") : String(value));
      current.index++;
    }
    wizardBusy(false);
    question();
  } catch (error) {
    if (wizard === current) { wizardMessage.textContent = error.message; wizardBusy(false); }
  }
});
wizardApply.addEventListener("click", async () => {
  const current = wizard;
  if (!current?.plan || !window.confirm(`Apply only the reviewed FixLab setup in ${current.repository}? No commands or jobs will run.`)) { return; }
  wizardApply.disabled = true;
  document.querySelector("#repository-onboarding-reload").disabled = true;
  try {
    await configurationRequest(current, { action: "apply", planId: current.plan.planId, confirmed: true });
    if (wizard !== current) { return; }
    wizardMessage.textContent = "Configuration saved. Dependencies, browser installation and human sign-in are not claimed as complete. Open the workspace to see readiness and connection controls.";
    wizardOpen.hidden = false;
  } catch (error) {
    if (wizard === current) { wizardMessage.textContent = error.message; wizardApply.disabled = false; }
  } finally {
    if (wizard === current) { document.querySelector("#repository-onboarding-reload").disabled = false; }
  }
});
document.querySelector("#repository-onboarding-reload").addEventListener("click", async () => {
  const current = wizard;
  if (!current) { return; }
  const button = document.querySelector("#repository-onboarding-reload");
  button.disabled = true;
  try {
    const configuration = await loadConfiguration(current.repository);
    if (wizard !== current) { return; }
    Object.assign(current, configuration, { index: 0, plan: null });
    wizardForm.hidden = false;
    wizardApply.disabled = false;
    wizardOpen.hidden = true;
    wizardOpen.disabled = false;
    document.querySelector("#repository-onboarding-review").hidden = true;
    wizardMessage.textContent = "";
    appendMessage("FixLab", "Loaded the repository's current settings. No previous setup plan can be applied from this conversation.");
    question();
  } catch (error) {
    if (wizard === current) { wizardMessage.textContent = error.message; }
  } finally {
    if (wizard === current) { button.disabled = false; }
  }
});
wizardOpen.addEventListener("click", async () => {
  const current = wizard;
  if (!current) { return; }
  wizardOpen.disabled = true;
  try {
    const result = await configurationRequest(current, { action: "open", repository: current.repository, confirmed: true });
    if (wizard !== current) { return; }
    const url = new URL(result.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("The repository workspace returned an invalid local URL.");
    }
    window.location.assign(url.href);
  } catch (error) {
    if (wizard === current) { wizardMessage.textContent = error.message; wizardOpen.disabled = false; }
  }
});

function settingValues() {
  return Object.fromEntries(settings.fields.map((field) => {
    const input = settingsForm.elements.namedItem(field.key);
    return [field.key, field.type === "boolean" ? input.checked : field.type === "number" ? Number(input.value) : input.value];
  }));
}
function settingsVisibility() {
  if (!settings) { return; }
  const values = settingValues();
  for (const field of settings.fields) {
    settingsForm.elements.namedItem(field.key).closest("label").hidden =
      Boolean((field.when && !values[field.when]) || (field.unless && values[field.unless]));
  }
}
function settingsBusy(busy) {
  settingsForm.querySelectorAll("input, button").forEach((element) => { element.disabled = busy; });
  document.querySelector("#repository-settings-load").disabled = busy;
  settingsApply.disabled = busy || !settings?.plan;
}
document.querySelector("#repository-settings-load").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  settings = null;
  settingsForm.hidden = true;
  document.querySelector("#repository-settings-review").hidden = true;
  settingsApply.disabled = true;
  settingsMessage.textContent = "";
  try {
    settings = await loadConfiguration();
    settingsFields.replaceChildren();
    for (const field of settings.fields) {
      const label = document.createElement("label");
      label.textContent = field.label;
      const input = document.createElement("input");
      input.name = field.key;
      input.type = field.type === "boolean" ? "checkbox" : field.type;
      input.maxLength = 2048;
      if (field.type === "boolean") { input.checked = settings.values[field.key]; }
      else { input.value = settings.values[field.key]; }
      if (field.type === "number") { input.min = "1"; input.max = String(field.max); }
      label.append(input);
      settingsFields.append(label);
    }
    settingsForm.hidden = false;
    document.querySelector("#repository-settings-review").hidden = true;
    settingsVisibility();
  } catch (error) {
    settingsMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
settingsForm.addEventListener("input", () => {
  if (settings) { settings.plan = null; }
  document.querySelector("#repository-settings-review").hidden = true;
  settingsVisibility();
});
settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const current = settings;
  if (!current) { return; }
  const values = settingValues();
  current.plan = null;
  document.querySelector("#repository-settings-review").hidden = true;
  settingsBusy(true);
  settingsMessage.textContent = "";
  try {
    const plan = await configurationRequest(current, { action: "preview",
      repository: current.repository, revision: current.revision, values, install: false });
    if (settings !== current) { return; }
    current.plan = plan;
    displayPlan("#repository-settings-plan", plan);
    document.querySelector("#repository-settings-review").hidden = false;
  } catch (error) {
    if (settings === current) { settingsMessage.textContent = error.message; }
  } finally {
    if (settings === current) { settingsBusy(false); }
  }
});
settingsApply.addEventListener("click", async () => {
  const current = settings;
  if (!current?.plan || !window.confirm(`Apply the reviewed settings to ${current.repository}? Active resources will not be stopped.`)) { return; }
  settingsBusy(true);
  try {
    await configurationRequest(current, { action: "apply", planId: current.plan.planId, confirmed: true });
    if (settings !== current) { return; }
    current.plan = null;
    document.querySelector("#repository-settings-review").hidden = true;
    settingsMessage.textContent = "Repository settings saved. Reload settings before another edit; no job or command was started.";
    settingsForm.hidden = true;
  } catch (error) {
    if (settings === current) {
      current.plan = null;
      document.querySelector("#repository-settings-review").hidden = true;
      settingsMessage.textContent = `${error.message} Review a new plan before saving again.`;
    }
  } finally {
    if (settings === current) { settingsBusy(false); }
  }
});

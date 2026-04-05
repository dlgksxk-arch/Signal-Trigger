const workflowPage = document.querySelector(".workflow-page");

if (workflowPage) {
  const workflowLinks = Array.from(document.querySelectorAll("[data-workflow-link]"));
  const workflowPanels = Array.from(document.querySelectorAll("[data-step-panel]"));
  const currentStepLabel = document.querySelector("[data-current-step-label]");

  const setActiveStep = (step) => {
    let selectedLabel = "";

    workflowLinks.forEach((link) => {
      const isActive = link.dataset.stepTarget === step;
      link.classList.toggle("active", isActive);
      link.setAttribute("aria-current", isActive ? "page" : "false");
      if (isActive) {
        selectedLabel = link.dataset.stepLabel || "";
      }
    });

    workflowPanels.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.stepPanel === step);
    });

    if (currentStepLabel && selectedLabel) {
      currentStepLabel.textContent = selectedLabel;
    }

    workflowPage.dataset.activeStep = step;
  };

  const getStepFromUrl = () => {
    const url = new URL(window.location.href);
    return url.searchParams.get("step") || workflowPage.dataset.activeStep || "topic";
  };

  workflowLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      event.preventDefault();

      const step = link.dataset.stepTarget;
      if (!step) {
        window.location.href = link.href;
        return;
      }

      setActiveStep(step);

      const nextHref = link.dataset.stepHref || link.href;
      window.history.replaceState({ step }, "", nextHref);
    });
  });

  window.addEventListener("popstate", () => {
    const currentPath = window.location.pathname.split("/").filter(Boolean);
    const pathStep = currentPath[currentPath.length - 1];
    setActiveStep(pathStep || getStepFromUrl());
  });

  const initialPath = window.location.pathname.split("/").filter(Boolean);
  const initialStep = initialPath[initialPath.length - 1];
  setActiveStep(initialStep || getStepFromUrl());
}

const workflowPage = document.querySelector(".workflow-page");

if (workflowPage) {
  const workflowLinks = Array.from(document.querySelectorAll("[data-workflow-link]"));
  const workflowPanels = Array.from(document.querySelectorAll("[data-step-panel]"));
  const currentStepLabel = document.querySelector("[data-current-step-label]");
  const sceneModal = document.querySelector("[data-scene-modal]");
  const sceneModalTitle = document.querySelector("[data-scene-modal-title]");
  const sceneModalImage = document.querySelector("[data-scene-modal-image]");
  const sceneModalPrompt = document.querySelector("[data-scene-modal-prompt]");
  const sceneModalNarration = document.querySelector("[data-scene-modal-narration]");
  const sceneModalForm = document.querySelector("[data-scene-modal-form]");

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

  if (sceneModal) {
    const sceneOpeners = Array.from(document.querySelectorAll("[data-scene-open]"));
    const sceneClosers = Array.from(document.querySelectorAll("[data-scene-close]"));

    const openSceneModal = (button) => {
      sceneModal.hidden = false;
      document.body.classList.add("modal-open");

      if (sceneModalTitle) {
        sceneModalTitle.textContent = button.dataset.sceneTitle || "장면 미리보기";
      }

      if (sceneModalImage) {
        sceneModalImage.src = button.dataset.sceneImage || "";
        sceneModalImage.alt = button.dataset.sceneTitle || "장면 이미지";
      }

      if (sceneModalPrompt) {
        sceneModalPrompt.textContent = button.dataset.scenePrompt || "";
      }

      if (sceneModalNarration) {
        sceneModalNarration.textContent = button.dataset.sceneNarration || "";
      }

      if (sceneModalForm) {
        sceneModalForm.action = button.dataset.sceneAction || "";
      }
    };

    const closeSceneModal = () => {
      sceneModal.hidden = true;
      document.body.classList.remove("modal-open");
    };

    sceneOpeners.forEach((button) => {
      button.addEventListener("click", () => openSceneModal(button));
    });

    sceneClosers.forEach((button) => {
      button.addEventListener("click", closeSceneModal);
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !sceneModal.hidden) {
        closeSceneModal();
      }
    });
  }
}

(() => {
  const form = document.getElementById("scheduleForm");
  const enabled = document.getElementById("enabled");
  const startTime = document.getElementById("startTime");
  const endTime = document.getElementById("endTime");
  const statusText = document.getElementById("statusText");
  const saveButton = document.getElementById("saveButton");

  function render(value) {
    const schedule = value.schedule;
    enabled.checked = schedule.enabled;
    startTime.value = schedule.start;
    endTime.value = schedule.end;
    startTime.disabled = !schedule.enabled;
    endTime.disabled = !schedule.enabled;
    statusText.dataset.state = "ready";
    if (!schedule.enabled) statusText.textContent = "自动巡检已关闭";
    else if (value.allowed) statusText.textContent = `当前在巡检时段内（${schedule.start}-${schedule.end}）`;
    else statusText.textContent = `当前暂停，下次从 ${schedule.start} 开始巡检`;
  }

  enabled.addEventListener("change", () => {
    startTime.disabled = !enabled.checked;
    endTime.disabled = !enabled.checked;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (enabled.checked && startTime.value === endTime.value) {
      statusText.dataset.state = "error";
      statusText.textContent = "开始时间和结束时间不能相同";
      return;
    }
    saveButton.disabled = true;
    statusText.dataset.state = "ready";
    statusText.textContent = "正在保存";
    try {
      render(await window.shadowPet.updateAttentionSchedule({
        enabled: enabled.checked,
        start: startTime.value,
        end: endTime.value,
      }));
      statusText.textContent = "设置已保存，后台将在 15 秒内生效";
    } catch (error) {
      statusText.dataset.state = "error";
      statusText.textContent = `保存失败：${error.message}`;
    } finally {
      saveButton.disabled = false;
    }
  });

  document.getElementById("cancelButton").addEventListener("click", () => window.close());
  window.shadowPet.onAttentionSchedule(render);
  window.shadowPet.attentionSchedule().then(render).catch((error) => {
    statusText.dataset.state = "error";
    statusText.textContent = `读取失败：${error.message}`;
  });
})();

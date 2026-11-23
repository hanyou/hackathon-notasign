function OnAddinLoad(ribbonUI) {
  window.Application.ribbonUI = ribbonUI;
  return true;
}

function OnAction(control) {
  if (control.Id !== 'btnShowTaskPane') return true;
  var app = window.Application;
  var taskPaneId = app.PluginStorage.getItem('notasign_taskpane_id');
  if (!taskPaneId) {
    var taskPane = app.CreateTaskPane(GetUrlPath() + '/ui/taskpane.html');
    app.PluginStorage.setItem('notasign_taskpane_id', taskPane.ID);
    taskPane.Visible = true;
  } else {
    var existingPane = app.GetTaskPane(taskPaneId);
    existingPane.Visible = !existingPane.Visible;
  }
  return true;
}

function OnGetEnabled() {
  return true;
}

function GetImage(control) {
  return control.Id === 'btnShowTaskPane' ? 'images/notasign.svg' : '';
}

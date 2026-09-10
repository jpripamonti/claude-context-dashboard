-- Template for the double-clickable launcher. macos/build-launcher.sh fills in
-- this project's real location below and compiles it into an .app, so moving
-- the project and rebuilding is enough to fix the path.
--
-- Asks which project to inspect, then hands it to bin/open-dashboard.sh, which
-- starts the dashboard server (or reuses one already running) and opens the
-- browser straight to that project.

property dashboardDir : "__DASHBOARD_DIR__"

try
	set chosenFolder to choose folder with prompt "Which project do you want to inspect?"
on error number -128
	-- user clicked Cancel — just quit quietly
	return
end try

set posixPath to POSIX path of chosenFolder
set scriptPath to dashboardDir & "/bin/open-dashboard.sh"

try
	do shell script quoted form of scriptPath & " " & quoted form of posixPath
on error errText
	display alert "Claude context dashboard couldn't start" message errText
end try

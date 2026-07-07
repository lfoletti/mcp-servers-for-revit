using System;
using Autodesk.Revit.UI;
using System.Reflection;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;



namespace revit_mcp_plugin.Core
{
    public class Application : IExternalApplication
    {
        // 缓存切换按钮、UI 线程调度器，以及彩色/置灰两套图标，
        // 以便按服务真实状态刷新图标（含后台线程触发的自动关闭）。
        // Cache the toggle button, the UI-thread dispatcher, and the colour/greyed
        // icon pairs so the icon can track the service's real state — including the
        // auto-off, which fires from a background timer thread.
        private static PushButton _toggleButton;
        private static Dispatcher _uiDispatcher;
        private static ImageSource _iconActive16, _iconActive32;
        private static ImageSource _iconIdle16, _iconIdle32;

        public Result OnStartup(UIControlledApplication application)
        {
            RibbonPanel mcpPanel = application.CreateRibbonPanel("Revit MCP Plugin");

            var icon16 = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/icon-16.png", UriKind.RelativeOrAbsolute));
            var icon32 = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/icon-32.png", UriKind.RelativeOrAbsolute));

            PushButtonData pushButtonData = new PushButtonData("ID_EXCMD_TOGGLE_REVIT_MCP", "Connecter à\r\nClaude Code",
                Assembly.GetExecutingAssembly().Location, "revit_mcp_plugin.Core.MCPServiceConnection");
            pushButtonData.ToolTip = "Ouvrir / fermer le serveur MCP (connexion à Claude Code)";
            pushButtonData.Image = icon16;
            pushButtonData.LargeImage = icon32;
            _toggleButton = mcpPanel.AddItem(pushButtonData) as PushButton;

            PushButtonData mcp_settings_pushButtonData = new PushButtonData("ID_EXCMD_MCP_SETTINGS", "Settings",
                Assembly.GetExecutingAssembly().Location, "revit_mcp_plugin.Core.Settings");
            mcp_settings_pushButtonData.ToolTip = "MCP Settings";
            mcp_settings_pushButtonData.Image = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/settings-16.png", UriKind.RelativeOrAbsolute));
            mcp_settings_pushButtonData.LargeImage = new BitmapImage(new Uri("/RevitMCPPlugin;component/Core/Ressources/settings-32.png", UriKind.RelativeOrAbsolute));
            mcpPanel.AddItem(mcp_settings_pushButtonData);

            // 按钮已就位。以下是"锦上添花"的图标反馈：置灰图标、UI 调度器、
            // 状态订阅。任何一步失败都不得阻止插件（及 MCP 服务）加载，故整体
            // try/catch 包裹并回退到彩色图标。
            // The button is in place. What follows is the "nice to have" icon feedback:
            // greyed icon, UI dispatcher, state subscription. None of it may block the
            // add-in (and the MCP service) from loading — so wrap it all in a try/catch
            // and fall back to the colour icon if anything fails.
            try
            {
                _uiDispatcher = Dispatcher.CurrentDispatcher;
                _iconActive16 = icon16;
                _iconActive32 = icon32;
                _iconIdle16 = ToGrayscale(icon16) ?? icon16;
                _iconIdle32 = ToGrayscale(icon32) ?? icon32;

                // 订阅服务状态：状态变化即刷新图标；自动关闭时另外通知用户。
                // Track service state: refresh the icon on any change; on an auto-off
                // also notify the user that the door closed by itself.
                SocketService.Instance.RunningStateChanged += (s, e) => RefreshToggleButton();
                SocketService.Instance.AutoStopped += (s, e) => OnAutoStopped();

                // 图标初始置灰（服务默认未启动）。
                // Start greyed out (the service is not running yet).
                RefreshToggleButton();
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    $"[revit_mcp] icon feedback setup skipped: {ex.Message}");
            }

            return Result.Succeeded;
        }

        // 由彩色图标实时生成置灰版本（服务停止时使用）。失败时返回 null，
        // 由调用方回退到彩色图标——绝不抛出到 OnStartup。
        // Derive a greyed-out version of a colour icon at runtime (used when stopped).
        // Returns null on failure so the caller can fall back to the colour icon —
        // never throws out to OnStartup.
        private static ImageSource ToGrayscale(BitmapImage source)
        {
            try
            {
                var gray = new FormatConvertedBitmap();
                gray.BeginInit();
                gray.Source = source;
                gray.DestinationFormat = PixelFormats.Gray8;
                gray.EndInit();
                // 不 Freeze：图标在 UI 线程创建并应用，同线程使用无需冻结，
                // 且 Freeze 对未完成下载的源会抛异常。
                // No Freeze: the icon is created and applied on the UI thread, so
                // same-thread use needs no freeze, and Freeze throws on a source that
                // has not finished downloading.
                return gray;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // 按服务真实状态刷新按钮图标（彩色=运行，置灰=停止）。
        // 若在后台线程被调用，切换到 UI 线程执行。
        // Refresh the button icon to match the service's real state (colour=running,
        // grey=stopped). Marshal to the UI thread when called from a background thread.
        internal static void RefreshToggleButton()
        {
            if (_toggleButton == null) return;

            bool running = SocketService.Instance.IsRunning;
            Action apply = () =>
            {
                _toggleButton.Image = running ? _iconActive16 : _iconIdle16;
                _toggleButton.LargeImage = running ? _iconActive32 : _iconIdle32;
            };

            if (_uiDispatcher != null && !_uiDispatcher.CheckAccess())
            {
                _uiDispatcher.BeginInvoke(apply);
            }
            else
            {
                apply();
            }
        }

        private static void OnAutoStopped()
        {
            RefreshToggleButton();

            _uiDispatcher?.BeginInvoke(new Action(() =>
            {
                TaskDialog.Show("Revit MCP",
                    "MCP Revit désactivé automatiquement après une période d'inactivité.");
            }));
        }

        public Result OnShutdown(UIControlledApplication application)
        {
            try
            {
                if (SocketService.Instance.IsRunning)
                {
                    SocketService.Instance.Stop();
                }
            }
            catch { }

            return Result.Succeeded;
        }
    }
}

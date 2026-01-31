using System;
using System.IO;
using System.Windows;
using LOD400Uploader.Services;

namespace LOD400Uploader.Views
{
    public partial class LoginDialog : Window
    {
        private readonly ApiService _apiService;
        private bool _isRegisterMode = false;
        private static readonly string ConfigPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "LOD400Uploader",
            "config.json"
        );

        public bool IsAuthenticated { get; private set; }
        public ApiService AuthenticatedApiService => _apiService;

        public LoginDialog()
        {
            InitializeComponent();
            _apiService = new ApiService();
            
            Loaded += (s, e) => LoadSavedEmail();
        }

        private void LoadSavedEmail()
        {
            try
            {
                string credEmail = CredentialService.LoadEmail();
                if (!string.IsNullOrEmpty(credEmail))
                {
                    EmailTextBox.Text = credEmail;
                    return;
                }

                if (File.Exists(ConfigPath))
                {
                    var json = File.ReadAllText(ConfigPath);
                    var config = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(json);
                    
                    string savedEmail = config?.email;
                    if (!string.IsNullOrEmpty(savedEmail))
                    {
                        EmailTextBox.Text = savedEmail;
                    }
                }
            }
            catch
            {
            }
        }

        private void SaveSession(string sessionToken, string email)
        {
            try
            {
                // Always save to file (ApiService loads from here)
                SaveSessionToFile(sessionToken, email);
                
                // Also try to save to Windows Credential Manager as backup
                try { CredentialService.SaveToken(sessionToken, email); } catch { }
            }
            catch
            {
            }
        }

        private void SaveSessionToFile(string sessionToken, string email)
        {
            try
            {
                var dir = Path.GetDirectoryName(ConfigPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                Newtonsoft.Json.Linq.JObject config;
                if (File.Exists(ConfigPath))
                {
                    try
                    {
                        var existingJson = File.ReadAllText(ConfigPath);
                        config = Newtonsoft.Json.Linq.JObject.Parse(existingJson);
                    }
                    catch
                    {
                        config = new Newtonsoft.Json.Linq.JObject();
                    }
                }
                else
                {
                    config = new Newtonsoft.Json.Linq.JObject();
                }

                config["email"] = email;
                config["sessionToken"] = sessionToken;
                
                File.WriteAllText(ConfigPath, config.ToString());
            }
            catch
            {
            }
        }

        private void SignInTab_Click(object sender, RoutedEventArgs e)
        {
            _isRegisterMode = false;
            SignInTab.Style = (Style)FindResource("TabButtonActive");
            RegisterTab.Style = (Style)FindResource("TabButton");
            SignInPanel.Visibility = Visibility.Visible;
            RegisterPanel.Visibility = Visibility.Collapsed;
            ActionButton.Content = "Sign In";
            ClearMessages();
        }

        private void RegisterTab_Click(object sender, RoutedEventArgs e)
        {
            _isRegisterMode = true;
            RegisterTab.Style = (Style)FindResource("TabButtonActive");
            SignInTab.Style = (Style)FindResource("TabButton");
            RegisterPanel.Visibility = Visibility.Visible;
            SignInPanel.Visibility = Visibility.Collapsed;
            ActionButton.Content = "Create Account";
            ClearMessages();
        }

        private void ClearMessages()
        {
            ErrorText.Visibility = Visibility.Collapsed;
            SuccessText.Visibility = Visibility.Collapsed;
            RegErrorText.Visibility = Visibility.Collapsed;
            RegSuccessText.Visibility = Visibility.Collapsed;
        }

        private async void ActionButton_Click(object sender, RoutedEventArgs e)
        {
            if (_isRegisterMode)
            {
                await DoRegister();
            }
            else
            {
                await DoLogin();
            }
        }

        private async System.Threading.Tasks.Task DoLogin()
        {
            var email = EmailTextBox.Text?.Trim();
            var password = PasswordBox.Password;
            
            if (string.IsNullOrEmpty(email))
            {
                ShowError("Please enter your email address.");
                return;
            }
            
            // Basic email format validation
            if (!email.Contains("@") || !email.Contains("."))
            {
                ShowError("Please enter a valid email address.");
                return;
            }

            if (string.IsNullOrEmpty(password))
            {
                ShowError("Please enter your password.");
                return;
            }

            ActionButton.IsEnabled = false;
            ActionButton.Content = "Signing in...";
            ClearMessages();

            try
            {
                var loginResult = await _apiService.LoginAsync(email, password);
                
                if (loginResult.Success)
                {
                    _apiService.SetSessionToken(loginResult.Token);
                    SaveSession(loginResult.Token, email);
                    IsAuthenticated = true;
                    DialogResult = true;
                    Close();
                }
                else
                {
                    // Provide more helpful error messages
                    string errorMsg = loginResult.ErrorMessage ?? "Invalid email or password.";
                    if (errorMsg.Contains("not found") || errorMsg.Contains("no account"))
                    {
                        errorMsg = "No account found with this email. Please register first.";
                    }
                    else if (errorMsg.Contains("password") || errorMsg.Contains("invalid"))
                    {
                        errorMsg = "Incorrect password. Please try again or reset your password.";
                    }
                    ShowError(errorMsg);
                }
            }
            catch (System.Net.Http.HttpRequestException)
            {
                ShowError("Unable to connect. Please check your internet connection.");
            }
            catch (TaskCanceledException)
            {
                ShowError("Connection timed out. Please try again.");
            }
            catch (Exception ex)
            {
                ShowError($"Connection failed: {ex.Message}");
            }
            finally
            {
                ActionButton.IsEnabled = true;
                ActionButton.Content = "Sign In";
            }
        }

        private async System.Threading.Tasks.Task DoRegister()
        {
            var email = RegEmailTextBox.Text?.Trim();
            var company = CompanyTextBox.Text?.Trim();
            var password = RegPasswordBox.Password;
            var confirmPassword = ConfirmPasswordBox.Password;
            
            if (string.IsNullOrEmpty(email))
            {
                ShowRegError("Please enter your email address.");
                return;
            }
            
            // Basic email format validation
            if (!email.Contains("@") || !email.Contains("."))
            {
                ShowRegError("Please enter a valid email address.");
                return;
            }

            if (string.IsNullOrEmpty(password))
            {
                ShowRegError("Please enter a password.");
                return;
            }

            if (password.Length < 6)
            {
                ShowRegError("Password must be at least 6 characters.");
                return;
            }
            
            // Check for password strength
            bool hasLetter = false;
            bool hasDigit = false;
            foreach (char c in password)
            {
                if (char.IsLetter(c)) hasLetter = true;
                if (char.IsDigit(c)) hasDigit = true;
            }
            if (!hasLetter || !hasDigit)
            {
                ShowRegError("Password must contain at least one letter and one number.");
                return;
            }

            if (password != confirmPassword)
            {
                ShowRegError("Passwords do not match.");
                return;
            }

            ActionButton.IsEnabled = false;
            ActionButton.Content = "Creating account...";
            ClearMessages();

            try
            {
                var registerResult = await _apiService.RegisterAsync(email, password, company);
                
                if (registerResult.Success)
                {
                    ShowRegSuccess("Account created! You can now sign in.");
                    
                    EmailTextBox.Text = email;
                    
                    await System.Threading.Tasks.Task.Delay(1500);
                    SignInTab_Click(null, null);
                }
                else
                {
                    // Provide more helpful error messages
                    string errorMsg = registerResult.ErrorMessage ?? "Registration failed.";
                    if (errorMsg.Contains("already exists") || errorMsg.Contains("already registered"))
                    {
                        errorMsg = "This email is already registered. Please sign in instead.";
                    }
                    ShowRegError(errorMsg);
                }
            }
            catch (System.Net.Http.HttpRequestException)
            {
                ShowRegError("Unable to connect. Please check your internet connection.");
            }
            catch (TaskCanceledException)
            {
                ShowRegError("Connection timed out. Please try again.");
            }
            catch (Exception ex)
            {
                ShowRegError($"Connection failed: {ex.Message}");
            }
            finally
            {
                ActionButton.IsEnabled = true;
                ActionButton.Content = "Create Account";
            }
        }

        private void ShowError(string message)
        {
            ErrorText.Text = message;
            ErrorText.Visibility = Visibility.Visible;
            SuccessText.Visibility = Visibility.Collapsed;
        }

        private void ShowSuccess(string message)
        {
            SuccessText.Text = message;
            SuccessText.Visibility = Visibility.Visible;
            ErrorText.Visibility = Visibility.Collapsed;
        }

        private void ShowRegError(string message)
        {
            RegErrorText.Text = message;
            RegErrorText.Visibility = Visibility.Visible;
            RegSuccessText.Visibility = Visibility.Collapsed;
        }

        private void ShowRegSuccess(string message)
        {
            RegSuccessText.Text = message;
            RegSuccessText.Visibility = Visibility.Visible;
            RegErrorText.Visibility = Visibility.Collapsed;
        }

        private void CancelButton_Click(object sender, RoutedEventArgs e)
        {
            DialogResult = false;
            Close();
        }
    }
}

using System;
using System.Runtime.InteropServices;
using System.Text;

namespace LOD400Uploader.Services
{
    /// <summary>
    /// Secure token storage using Windows Credential Manager.
    /// Replaces plaintext JSON file storage to protect credentials on shared workstations.
    /// </summary>
    public static class CredentialService
    {
        private const string TargetName = "LOD400Platform_AuthToken";
        private const string EmailTargetName = "LOD400Platform_Email";

        #region Native Methods

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CredWriteW(ref CREDENTIAL userCredential, uint flags);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CredDeleteW(string target, int type, int flags);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CredFree(IntPtr cred);

        private const int CRED_TYPE_GENERIC = 1;
        private const int CRED_PERSIST_LOCAL_MACHINE = 2;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            public string TargetName;
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        #endregion

        /// <summary>
        /// Saves the authentication token securely using Windows Credential Manager.
        /// </summary>
        public static bool SaveToken(string token, string email)
        {
            try
            {
                // Save token
                if (!SaveCredential(TargetName, token, "LOD400User"))
                    return false;

                // Save email separately
                if (!SaveCredential(EmailTargetName, email, "LOD400Email"))
                    return false;

                return true;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to save credentials: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Loads the authentication token from Windows Credential Manager.
        /// </summary>
        public static string LoadToken()
        {
            return LoadCredential(TargetName);
        }

        /// <summary>
        /// Loads the stored email from Windows Credential Manager.
        /// </summary>
        public static string LoadEmail()
        {
            return LoadCredential(EmailTargetName);
        }

        /// <summary>
        /// Deletes all stored credentials (logout).
        /// </summary>
        public static void DeleteCredentials()
        {
            try
            {
                CredDeleteW(TargetName, CRED_TYPE_GENERIC, 0);
                CredDeleteW(EmailTargetName, CRED_TYPE_GENERIC, 0);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Failed to delete credentials: {ex.Message}");
            }
        }

        /// <summary>
        /// Checks if valid credentials exist.
        /// </summary>
        public static bool HasStoredCredentials()
        {
            return !string.IsNullOrEmpty(LoadToken());
        }

        #region Private Methods

        private static bool SaveCredential(string target, string secret, string userName)
        {
            byte[] secretBytes = Encoding.Unicode.GetBytes(secret);
            IntPtr secretPtr = Marshal.AllocHGlobal(secretBytes.Length);
            Marshal.Copy(secretBytes, 0, secretPtr, secretBytes.Length);

            var credential = new CREDENTIAL
            {
                Type = CRED_TYPE_GENERIC,
                TargetName = target,
                CredentialBlobSize = (uint)secretBytes.Length,
                CredentialBlob = secretPtr,
                Persist = CRED_PERSIST_LOCAL_MACHINE,
                UserName = userName,
                Comment = "LOD 400 Platform authentication"
            };

            try
            {
                return CredWriteW(ref credential, 0);
            }
            finally
            {
                Marshal.FreeHGlobal(secretPtr);
            }
        }

        private static string LoadCredential(string target)
        {
            IntPtr credPtr;
            if (!CredReadW(target, CRED_TYPE_GENERIC, 0, out credPtr))
            {
                return null;
            }

            try
            {
                var credential = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
                if (credential.CredentialBlobSize == 0 || credential.CredentialBlob == IntPtr.Zero)
                {
                    return null;
                }

                byte[] secretBytes = new byte[credential.CredentialBlobSize];
                Marshal.Copy(credential.CredentialBlob, secretBytes, 0, (int)credential.CredentialBlobSize);
                return Encoding.Unicode.GetString(secretBytes);
            }
            finally
            {
                CredFree(credPtr);
            }
        }

        #endregion
    }
}

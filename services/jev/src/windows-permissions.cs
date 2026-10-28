using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

internal static class WindowsPermissions
{
    private static FileSystemSecurity Read(string path, bool directory)
    {
        const AccessControlSections sections = AccessControlSections.Owner | AccessControlSections.Access;
        return directory ? (FileSystemSecurity)Directory.GetAccessControl(path, sections)
            : File.GetAccessControl(path, sections);
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || (args[0] != "check" && args[0] != "restrict")) return 1;
            string path = args[1];
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) return 1;
            bool directory = (attributes & FileAttributes.Directory) != 0;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                SecurityIdentifier sid = identity.User;
                FileSystemSecurity acl = Read(path, directory);
                if (!acl.GetOwner(typeof(SecurityIdentifier)).Equals(sid)) return 1;
                if (args[0] == "restrict")
                {
                    if (!directory) return 1;
                    DirectorySecurity restricted = new DirectorySecurity();
                    restricted.SetOwner(sid);
                    restricted.SetAccessRuleProtection(true, false);
                    restricted.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                        PropagationFlags.None, AccessControlType.Allow));
                    Directory.SetAccessControl(path, restricted);
                    acl = Read(path, true);
                }
                AuthorizationRuleCollection rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
                if (rules.Count == 0) return 1;
                bool fullControl = false;
                foreach (FileSystemAccessRule rule in rules)
                {
                    if (!rule.IdentityReference.Equals(sid) || rule.AccessControlType != AccessControlType.Allow) return 1;
                    if ((rule.FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl
                        && (rule.PropagationFlags & PropagationFlags.InheritOnly) == 0) fullControl = true;
                }
                return fullControl ? 0 : 1;
            }
        }
        catch
        {
            // Paths, identity details and credential contents never leave this helper.
            return 1;
        }
    }
}

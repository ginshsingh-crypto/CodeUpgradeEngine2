
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Users } from "lucide-react";

export default function CompanyManagement() {
    const { toast } = useToast();
    const [newCompanyName, setNewCompanyName] = useState("");
    const [inviteEmail, setInviteEmail] = useState("");
    const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

    // Fetch companies user belongs to (or all if admin?? No, companies user manages)
    // Currently the API is /api/companies/:id to get details.
    // We need an endpoint to list my companies or created companies.
    // Let's assume for now we might need to add a "list my companies" endpoint or similar.
    // Wait, `getUserBalances` returns companies. Maybe we use that?

    const { data: balanceData } = useQuery<{
        personal: number;
        companies: Array<{ id: string; name: string; balanceSar: number; role: string }>;
    }>({
        queryKey: ["/api/balance"],
    });

    const companies = balanceData?.companies || [];

    const createCompanyMutation = useMutation({
        mutationFn: async (name: string) => {
            const res = await apiRequest("POST", "/api/companies", { name });
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/balance"] });
            setNewCompanyName("");
            toast({ title: "Company created successfully" });
        },
        onError: (err: Error) => {
            toast({ title: "Failed to create company", description: err.message, variant: "destructive" });
        },
    });

    const { data: members, refetch: refetchMembers } = useQuery({
        queryKey: ["/api/companies", selectedCompanyId, "members"],
        queryFn: async () => {
            if (!selectedCompanyId) return [];
            const res = await apiRequest("GET", `/api/companies/${selectedCompanyId}/members`);
            return res.json();
        },
        enabled: !!selectedCompanyId
    });

    const addMemberMutation = useMutation({
        mutationFn: async ({ companyId, email }: { companyId: string; email: string }) => {
            const res = await apiRequest("POST", `/api/companies/${companyId}/members`, {
                email,
                role: "member",
            });
            return res.json();
        },
        onSuccess: () => {
            refetchMembers();
            setInviteEmail("");
            toast({ title: "Member added successfully" });
        },
        onError: (err: Error) => {
            toast({ title: "Failed to add member", description: err.message, variant: "destructive" });
        }
    });

    const removeMemberMutation = useMutation({
        mutationFn: async ({ companyId, userId }: { companyId: string, userId: string }) => {
            await apiRequest("DELETE", `/api/companies/${companyId}/members/${userId}`);
        },
        onSuccess: () => {
            refetchMembers();
            toast({ title: "Member removed" });
        }
    });

    return (
        <div className="flex-1 w-full flex flex-col p-8 gap-8 overflow-y-auto">
            <div>
                <h1 className="text-3xl font-bold tracking-tight">Company Management</h1>
                <p className="text-muted-foreground mt-2">
                    Create companies and manage team members.
                </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Create New Company</CardTitle>
                        <CardDescription>Start a new organization with a shared balance.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="flex gap-4">
                            <Input
                                placeholder="Company Name"
                                value={newCompanyName}
                                onChange={(e) => setNewCompanyName(e.target.value)}
                            />
                            <Button
                                onClick={() => createCompanyMutation.mutate(newCompanyName)}
                                disabled={!newCompanyName || createCompanyMutation.isPending}
                            >
                                <Plus className="mr-2 h-4 w-4" />
                                Create
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* List of Companies */}
                <Card className="md:col-span-2">
                    <CardHeader>
                        <CardTitle>Your Companies</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex gap-4 flex-wrap">
                            {companies.map((company: any) => (
                                <Button
                                    key={company.id}
                                    variant={selectedCompanyId === company.id ? "default" : "outline"}
                                    className="h-auto py-4 px-6 flex flex-col items-start gap-1"
                                    onClick={() => setSelectedCompanyId(company.id)}
                                >
                                    <span className="font-semibold text-lg">{company.name}</span>
                                    <span className="text-xs opacity-70 capitalize">{company.role}</span>
                                </Button>
                            ))}
                            {companies.length === 0 && <p className="text-muted-foreground">No companies found.</p>}
                        </div>
                    </CardContent>
                </Card>

                {/* Selected Company Details */}
                {selectedCompanyId && (
                    <Card className="md:col-span-2">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Users className="h-5 w-5" />
                                Team Members
                            </CardTitle>
                            <CardDescription>Manage access to this company.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {/* Add Member */}
                            <div className="flex gap-4 items-end max-w-md">
                                <div className="grid gap-2 flex-1">
                                    <Label htmlFor="email">Invite by Email</Label>
                                    <Input
                                        id="email"
                                        placeholder="colleague@example.com"
                                        value={inviteEmail}
                                        onChange={(e) => setInviteEmail(e.target.value)}
                                    />
                                </div>
                                <Button
                                    onClick={() => addMemberMutation.mutate({ companyId: selectedCompanyId, email: inviteEmail })}
                                    disabled={!inviteEmail || addMemberMutation.isPending}
                                >
                                    Invite
                                </Button>
                            </div>

                            {/* Members Table */}
                            <div className="rounded-md border">
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead>User</TableHead>
                                            <TableHead>Role</TableHead>
                                            <TableHead>Joined</TableHead>
                                            <TableHead className="text-right">Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {members?.map((member: any) => (
                                            <TableRow key={member.id}>
                                                <TableCell>
                                                    <div className="font-medium">{member.firstName} {member.lastName}</div>
                                                    <div className="text-xs text-muted-foreground">{member.email}</div>
                                                </TableCell>
                                                <TableCell className="capitalize">{member.role}</TableCell>
                                                <TableCell className="text-muted-foreground text-sm">
                                                    {new Date(member.createdAt).toLocaleDateString()}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    {member.role !== 'admin' && ( // Can't remove admin easily yet
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => removeMemberMutation.mutate({ companyId: selectedCompanyId, userId: member.userId })}
                                                        >
                                                            <Trash2 className="h-4 w-4 text-destructive" />
                                                        </Button>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}

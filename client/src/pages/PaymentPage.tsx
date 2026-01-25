import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/lib/companyContext";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CreditCard, Wallet, ArrowLeft } from "lucide-react";
import type { OrderWithFiles } from "@shared/schema";

export default function PaymentPage() {
    const [, params] = useRoute("/payment/:orderId");
    const orderId = params?.orderId;
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const {
        selectedCompanyId,
        selectedCompany,
        companies,
        isLoading: isBalanceLoading,
        personalBalance,
    } = useCompany();

    const { data: order, isLoading: isOrderLoading } = useQuery<OrderWithFiles>({
        queryKey: [`/api/orders/${orderId}`],
        enabled: !!orderId,
    });

    const payWithBalanceMutation = useMutation({
        mutationFn: async () => {
            const res = await apiRequest("POST", `/api/orders/${orderId}/pay-with-balance`, {
                companyId: selectedCompanyId,
            });
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
            queryClient.invalidateQueries({ queryKey: ["/api/balance"] });
            toast({
                title: "Payment Successful",
                description: "Order paid using balance.",
            });
            setLocation("/");
        },
        onError: (err: Error) => {
            toast({
                title: "Payment Failed",
                description: err.message,
                variant: "destructive",
            });
        },
    });

    const initiateMoyasarPayment = async () => {
        if (!orderId) return;
        try {
            const res = await apiRequest("POST", `/api/orders/${orderId}/payment-intent`);
            const data = await res.json();
            if (data.formUrl) {
                window.location.href = data.formUrl;
                return;
            }
            throw new Error("No payment URL returned");
        } catch (err: any) {
            toast({
                title: "Error",
                description: err.message,
                variant: "destructive",
            });
        }
    };

    if (isOrderLoading || isBalanceLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!order) return <div>Order not found</div>;

    const associatedCompany = companies.find((c: any) => c.id === selectedCompanyId);
    const currentBalance = selectedCompanyId ? (associatedCompany?.balanceSar || 0) : personalBalance;
    const canPayWithBalance = currentBalance >= order.totalPriceSar;

    return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
            <Card className="w-full max-w-md">
                <CardHeader>
                    <div className="flex items-center gap-2 mb-2">
                        <Button variant="ghost" size="sm" onClick={() => setLocation("/")}
                        >
                            <ArrowLeft className="h-4 w-4 mr-1" /> Back
                        </Button>
                    </div>
                    <CardTitle>Checkout</CardTitle>
                    <CardDescription>Order #{order.id}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex justify-between items-center py-4 border-b">
                        <span className="font-medium">Total Amount</span>
                        <span className="text-2xl font-bold">{order.totalPriceSar} SAR</span>
                    </div>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <h3 className="text-sm font-medium text-muted-foreground uppercase opacity-70">Pay with Balance</h3>
                            <div className="p-4 border rounded-lg bg-muted/20">
                                <div className="flex justify-between mb-2">
                                    <span className="text-sm font-medium">
                                        {selectedCompanyId ? `Company: ${selectedCompany?.name || ""}` : "Personal Account"}
                                    </span>
                                    <span className="font-bold">{currentBalance} SAR</span>
                                </div>
                                <Button
                                    className="w-full"
                                    disabled={!canPayWithBalance || payWithBalanceMutation.isPending}
                                    onClick={() => payWithBalanceMutation.mutate()}
                                >
                                    <Wallet className="mr-2 h-4 w-4" />
                                    Pay with Balance
                                </Button>
                                {!canPayWithBalance && (
                                    <p className="text-xs text-destructive mt-2 text-center">Insufficient funds. Please top up or use card.</p>
                                )}
                            </div>
                        </div>

                        <div className="relative">
                            <div className="absolute inset-0 flex items-center">
                                <span className="w-full border-t" />
                            </div>
                            <div className="relative flex justify-center text-xs uppercase">
                                <span className="bg-background px-2 text-muted-foreground">Or pay with card</span>
                            </div>
                        </div>

                        <Button
                            variant="outline"
                            className="w-full py-6"
                            onClick={initiateMoyasarPayment}
                        >
                            <CreditCard className="mr-2 h-4 w-4" />
                            Pay with Credit Card (Moyasar)
                        </Button>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}

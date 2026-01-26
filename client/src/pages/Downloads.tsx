import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Download, FileIcon, Loader2 } from "lucide-react";
import { format } from "date-fns";

interface FileData {
  id: string;
  orderId: string;
  fileType: "input" | "output";
  fileName: string;
  fileSize: number | null;
  storageKey: string;
  mimeType: string | null;
  createdAt: string | null;
}

interface OrderWithFiles {
  id: string;
  status: string;
  sheetCount: number;
  totalPriceSar: number;
  completedAt: string | null;
  files?: FileData[];
}

export default function Downloads() {
  const { data: orders, isLoading } = useQuery<OrderWithFiles[]>({
    queryKey: ["/api/orders"],
    queryFn: async () => {
      const res = await fetch("/api/orders", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch orders");
      return res.json();
    },
  });

  const completedOrders = orders?.filter((order) => order.status === "complete") || [];

  const handleDownload = async (orderId: string, fileId: string) => {
    try {
      const res = await fetch(`/api/orders/${orderId}/files/${fileId}/download`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to get download URL");
      const data = await res.json();
      window.open(data.url, "_blank");
    } catch (error) {
      console.error("Download failed:", error);
    }
  };

  const formatFileSize = (bytes: number | null) => {
    if (!bytes) return "Unknown size";
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Downloads</h1>
        
        {completedOrders.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <FileIcon className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">
                No completed orders with downloadable files yet.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {completedOrders.map((order) => (
              <Card key={order.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-lg">Order #{order.id.slice(0, 8)}</CardTitle>
                      <CardDescription>
                        {order.sheetCount} sheets | Completed{" "}
                        {order.completedAt
                          ? format(new Date(order.completedAt), "MMM d, yyyy")
                          : "recently"}
                      </CardDescription>
                    </div>
                    <Badge variant="secondary">Complete</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {order.files && order.files.filter((f) => f.fileType === "output").length > 0 ? (
                    <div className="space-y-2">
                      {order.files
                        .filter((file) => file.fileType === "output")
                        .map((file) => (
                          <div
                            key={file.id}
                            className="flex items-center justify-between p-3 bg-muted rounded-lg"
                          >
                            <div className="flex items-center gap-3">
                              <FileIcon className="h-5 w-5 text-muted-foreground" />
                              <div>
                                <p className="font-medium">{file.fileName}</p>
                                <p className="text-sm text-muted-foreground">
                                  {formatFileSize(file.fileSize)}
                                </p>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              onClick={() => handleDownload(order.id, file.id)}
                            >
                              <Download className="h-4 w-4 mr-2" />
                              Download
                            </Button>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      No output files available for this order.
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

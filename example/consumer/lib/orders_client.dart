/// The client of the tiny order API: how it builds a request and what it makes of a
/// response. There is no HTTP here; a real client would send [ApiRequest] with its HTTP
/// library and pass the status and decoded body to [readCreateOrderResponse] or
/// [readStartPaymentResponse].
library;

class ApiRequest {
  const ApiRequest({
    required this.method,
    required this.path,
    required this.headers,
    this.body,
  });

  final String method;
  final String path;
  final Map<String, String> headers;
  final Object? body;
}

/// The request that places an order.
ApiRequest buildCreateOrderRequest({
  required String authorization,
  required String sku,
  required int quantity,
  String? coupon,
}) {
  return ApiRequest(
    method: 'POST',
    path: '/orders',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json',
    },
    body: {
      'sku': sku,
      'quantity': quantity,
      if (coupon != null) 'coupon': coupon,
    },
  );
}

/// What the app does after it asked to place an order.
sealed class OrderOutcome {
  const OrderOutcome();
}

/// Show the confirmation screen.
class OrderPlaced extends OrderOutcome {
  const OrderPlaced(this.id, this.totalMinor);
  final String id;
  final int totalMinor;
}

/// Tell the customer how many are left.
class OutOfStock extends OrderOutcome {
  const OutOfStock(this.available);
  final int available;
}

/// Mark the coupon field as wrong.
class CouponRejected extends OrderOutcome {
  const CouponRejected();
}

/// Send the customer to the sign-in screen.
class SignInAgain extends OrderOutcome {
  const SignInAgain();
}

/// Show a generic error.
class OrderFailed extends OrderOutcome {
  const OrderFailed();
}

/// What the app does after it asked to start the payment of an order.
sealed class PaymentOutcome {
  const PaymentOutcome();
}

/// Hand the confirm key to the payment screen. The key is a secret: it is never logged.
class PaymentStarted extends PaymentOutcome {
  const PaymentStarted(this.paymentId, this.confirmKey);
  final String paymentId;
  final String confirmKey;
}

/// Show a generic error.
class PaymentFailed extends PaymentOutcome {
  const PaymentFailed();
}

PaymentOutcome readStartPaymentResponse(int status, Object? body) {
  if (status == 201 && body is Map<String, dynamic>) {
    return PaymentStarted(body['id'] as String, body['confirm_key'] as String);
  }
  return const PaymentFailed();
}

OrderOutcome readCreateOrderResponse(int status, Object? body) {
  final json = body is Map<String, dynamic> ? body : const <String, dynamic>{};
  if (status == 201) {
    return OrderPlaced(json['id'] as String, json['total_minor'] as int);
  }
  if (status == 401) return const SignInAgain();
  switch (json['error']) {
    case 'out_of_stock':
      return OutOfStock(json['available'] as int);
    case 'coupon_unknown':
      return const CouponRejected();
    default:
      return const OrderFailed();
  }
}

/// The total the app shows before the order is placed. It must agree with what the API
/// charges; both run the rows of `contracts/tables/order-total.json`.
int orderTotalMinor({
  required int unitPriceMinor,
  required int quantity,
  required int discountPercent,
}) {
  final subtotal = unitPriceMinor * quantity;
  final discount = (subtotal * discountPercent + 50) ~/ 100;
  return subtotal - discount;
}

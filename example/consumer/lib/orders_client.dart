/// The client of the tiny order API: how it builds a request, how it sends it with dio,
/// and what it makes of a response.
library;

import 'package:dio/dio.dart';

/// The calls the app makes. It is given the [Dio] to send with, so a test can hand it one
/// whose adapter answers with fixtures; everything else is the code the app runs.
class OrdersClient {
  OrdersClient(this._dio, {required this.authorization});

  final Dio _dio;
  final String authorization;

  Future<OrderOutcome> placeOrder({
    required String sku,
    required int quantity,
    String? coupon,
  }) async {
    final response = await _send(
      buildCreateOrderRequest(
        authorization: authorization,
        sku: sku,
        quantity: quantity,
        coupon: coupon,
      ),
    );
    return readCreateOrderResponse(response.statusCode ?? 0, response.data);
  }

  Future<PaymentOutcome> startPayment(String orderId) async {
    final response = await _send(
      ApiRequest(
        method: 'POST',
        path: '/payments',
        headers: {'Authorization': authorization},
        body: {'order_id': orderId},
      ),
    );
    return readStartPaymentResponse(response.statusCode ?? 0, response.data);
  }

  Future<ReceiptOutcome> loadReceipt(String orderId) async {
    final response = await _send(
      ApiRequest(
        method: 'GET',
        path: '/orders/$orderId/receipt',
        headers: {'Authorization': authorization},
      ),
    );
    return readReceiptResponse(
      response.statusCode ?? 0,
      // One value per name. (Joining is right for the headers of this response; it would
      // not be for set-cookie.)
      {
        for (final header in response.headers.map.entries)
          header.key: header.value.join(', '),
      },
      response.data,
    );
  }

  /// Every status is an answer the app reads, so none of them is an exception here.
  Future<Response<Object?>> _send(ApiRequest request) => _dio.request<Object?>(
        request.path,
        data: request.body,
        options: Options(
          method: request.method,
          headers: request.headers,
          validateStatus: (_) => true,
        ),
      );
}

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

/// What the app does after it asked for the receipt of an order.
sealed class ReceiptOutcome {
  const ReceiptOutcome();
}

/// Save the receipt under the file name the API gave.
class ReceiptReady extends ReceiptOutcome {
  const ReceiptReady(this.fileName, this.totalMinor);
  final String fileName;
  final int totalMinor;
}

/// Show a generic error.
class ReceiptFailed extends ReceiptOutcome {
  const ReceiptFailed();
}

final RegExp _attachment = RegExp(r'^attachment;\s*filename="([^"/\\]+)"$');

/// [headers] are the response headers with lower-case names, as an HTTP library gives them.
ReceiptOutcome readReceiptResponse(
  int status,
  Map<String, String> headers,
  Object? body,
) {
  final fileName =
      _attachment.firstMatch(headers['content-disposition'] ?? '')?.group(1);
  if (status != 200 ||
      fileName == null ||
      // Deliberately strict: the example API sends exactly this value.
      headers['content-type'] != 'application/json' ||
      body is! Map<String, dynamic>) {
    return const ReceiptFailed();
  }
  return ReceiptReady(fileName, body['total_minor'] as int);
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
